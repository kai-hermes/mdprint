// mdprint-pdf — offscreen HTML -> PDF using macOS's own web engine (WKWebView).
// NO window, NO tab, NO browser UI. Replaces "open Safari and press Cmd-P".
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE PAGINATES BY HAND
// ═══════════════════════════════════════════════════════════════════════════
// WKWebView.createPDF(configuration:) does NOT paginate. That is the single
// fact that shaped this whole file, and it was established empirically. The
// experiments are recorded here so nobody repeats them:
//
//   cfg.rect = A4, one page tall          -> 1 page; content past page 1 dropped
//   cfg.rect = A4 wide, 4 pages tall      -> ONE 594mm-tall sheet, /Count 1
//   cfg.rect = full page, full doc height  -> ONE 594mm-tall sheet, /Count 1
//   view frame = 4 pages tall             -> still /Count 1, MediaBox unchanged
//   @media print {html,body{height:100vh}} -> no effect on the page count
//   paged.js polyfill                      -> moves the source into
//                                             .pagedjs_pages, which the shim
//                                             then measures as empty (blank sheet)
//   NSPrintOperation                      -> 0 bytes without a window server
//                                             session, so unusable headless
//
// What createPDF IS: it rasterises exactly the region in cfg.rect into a PDF
// whose PAGE SIZE IS cfg.rect. It does not slice, and it does not honour @page.
// Anything you ask for taller than one page comes back as one tall piece of
// paper, which a printer will then either refuse or scale into mush.
//
// So pagination is done here, and the shape of the solution is:
//
//   1. Lay the document out at the real content-column width, so the margins
//      exist in the layout rather than being applied at raster time.
//   2. Ask the DOM where every top-level block starts and ends. Tables are
//      measured row by row so a long table breaks BETWEEN rows.
//   3. Greedily pack blocks into page-height buckets. A block never straddles a
//      page, which is what stops a paragraph being sliced in half.
//   4. For each page, translate the document up by that page's offset and
//      rasterise EXACTLY one A4 page. Repeating the measurement with the offset
//      applied (rather than assuming a simple shift) is what makes the break
//      positions exact when a break lands inside a margin.
//   5. Merge the single-page PDFs with PDFKit — macOS's own PDF framework, so
//      merging is a native operation rather than a hand-rolled file format.
//      A hand-written PDF concatenator was tried first and produced files that
//      CoreGraphics rejected; PDFKit is both correct and already present.
//
// TWO BUGS PAID FOR IN PAPER, both about layout rather than pagination:
//
// BUG 1 — THE MARGIN BUG (2026-09-21)
// createPDF() draws from the page origin with NO margin box. v1 laid the
// document out at the FULL page width, so content was 595.3pt wide on a 595.3pt
// page: zero margins, and anything wider than the page was sliced off at the
// right paper edge. A real sheet came back with text clipped.
// The fix is NOT to shrink the page — that produced 179.9 x 266.7mm paper. The
// fix is to lay the DOCUMENT OUT INSIDE the margin box.
//
// BUG 2 — ONE PAGE ONLY (2026-09-22)
// A long document silently printed as a single page with the table and the
// footer missing. The table is the giveaway: if a document ends without its
// last block, pagination is not happening.
import WebKit
import PDFKit
import Foundation
import AppKit

let MM: CGFloat = 72.0 / 25.4   // 1mm = 2.8346pt

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: mdprint-pdf <in.html> <out.pdf>\n".data(using: .utf8)!)
    exit(2)
}
let inPath = args[1]
let outPath = args[2]

// --- defaults = A4 with the same margins as mdprint.css -------------------
var pageW: CGFloat = 210 * MM
var pageH: CGFloat = 297 * MM
var mTop: CGFloat = 14 * MM
var mRight: CGFloat = 15 * MM
var mBottom: CGFloat = 16 * MM
var mLeft: CGFloat = 15 * MM

let src = (try? String(contentsOfFile: inPath, encoding: .utf8)) ?? ""

// @page geometry.
//
// Match EVERY @page block, not just the first. The built-in stylesheet opens
// with `@page :left`, `@page :right` and `@page :first` before the real one, and
// a user theme appends its own on top — so "the first block" is a margin-only
// pseudo-rule and honouring it silently discards the theme.
//
// Explicit `margin-*` longhands win over a `margin` shorthand in an EARLIER
// block, and a later `margin` shorthand wins over an earlier longhand. That is
// the CSS cascade the user is writing against, so it is the cascade applied
// here. (The shim never lets `createPDF` paginate — it reads geometry here and
// lays the document out itself, which is why this is the only place @page is
// honoured at all.)
var pageBlocks: [String] = []
var search = src.startIndex..<src.endIndex
while let r = src.range(of: "@page\\s*\\{[^}]*\\}", options: .regularExpression, range: search) {
    pageBlocks.append(String(src[r]))
    search = r.upperBound..<src.endIndex
}

/// Pull one `margin*` declaration out of a single @page block, as raw tokens.
func declaration(_ block: String, _ prop: String) -> String? {
    guard let m = block.range(of: prop + "\\s*:\\s*([^;}]+)", options: .regularExpression)
    else { return nil }
    let s = String(block[m])
    guard let colon = s.firstIndex(of: ":") else { return nil }
    return String(s[s.index(after: colon)...]).trimmingCharacters(in: CharacterSet(charactersIn: " ;}"))
}

/// `14mm 15mm 16mm 15mm` — CSS order: top right bottom left.
func boxFrom(_ spec: String, into current: inout (CGFloat, CGFloat, CGFloat, CGFloat)) -> Bool {
    let parts = spec
        .replacingOccurrences(of: "mm", with: "")
        .trimmingCharacters(in: CharacterSet(charactersIn: " ;}"))
        .split(separator: " ")
        .compactMap { Double($0).map { CGFloat($0) * MM } }
    switch parts.count {
    case 1: current = (parts[0], parts[0], parts[0], parts[0])
    case 2: current = (parts[0], parts[1], parts[0], parts[1])
    case 3: current = (parts[0], parts[1], parts[2], parts[1])
    case 4: current = (parts[0], parts[1], parts[2], parts[3])
    default: return false
    }
    return true
}

if !pageBlocks.isEmpty {
    var box: (CGFloat, CGFloat, CGFloat, CGFloat) = (mTop, mRight, mBottom, mLeft)

    // Walk the blocks in document order, letting later declarations win.
    for block in pageBlocks {
        if block.contains("size:A4") || block.contains("size: A4") {
            pageW = 210 * MM; pageH = 297 * MM
        } else if let spec = declaration(block, "size"),
                  let wh = spec.range(of: "([0-9.]+)mm\\s+([0-9.]+)mm", options: .regularExpression) {
            let nums = String(spec[wh]).replacingOccurrences(of: "mm", with: "")
                .split(separator: " ").compactMap { Double($0).map { CGFloat($0) * MM } }
            if nums.count == 2 { pageW = nums[0]; pageH = nums[1] }
        }

        if let spec = declaration(block, "margin"), boxFrom(spec, into: &box) {
            // Shorthand resets all four, exactly as CSS does.
        }
        // Longhands are applied after, so they always beat a shorthand in an
        // earlier block — and a later shorthand beats them in turn, because the
        // loop keeps moving forward.
        for (prop, idx) in [("margin-top", 0), ("margin-right", 1), ("margin-bottom", 2), ("margin-left", 3)] {
            if let spec = declaration(block, prop),
               let v = Double(spec.replacingOccurrences(of: "mm", with: "")
                   .trimmingCharacters(in: .whitespaces)) {
                switch idx {
                case 0: box.0 = CGFloat(v) * MM
                case 1: box.1 = CGFloat(v) * MM
                case 2: box.2 = CGFloat(v) * MM
                default: box.3 = CGFloat(v) * MM
                }
            }
        }
    }

    mTop = box.0; mRight = box.1; mBottom = box.2; mLeft = box.3
}

let contentW = pageW - mLeft - mRight

// BUG 6 — BODY TEXT RUNNING INTO THE FOOTER (2026-09-22). `contentH` used to be
// the WHOLE bottom margin (`pageH - mTop - mBottom`), and the footer was then
// placed at `pageH - mBottom` — i.e. exactly where a fully-packed page's last
// line of content also lands, because the packer is happy to fill content
// right up to `contentH`. The two were never going to miss each other: a page
// packed anywhere near full put its last line and the footer's first line at
// the same coordinate. FOOTER_RESERVE carves the footer its own band out of
// the bottom margin, so `contentH` is the height content may actually use, and
// the footer sits below that with a real gap on every page — not just the
// underfull ones.
let FOOTER_RESERVE: CGFloat = 32
let contentH = pageH - mTop - mBottom - FOOTER_RESERVE

// How much slack the packer leaves under `contentH` for measure/render drift
// (BUG 7 — a table cell or code block occasionally rewraps by a line between
// the JS measurement pass and `createPDF`'s own print layout pass). This is
// its ONLY job now: BUG 8's ghost-content-below-the-footer problem is fixed
// structurally in `renderPages` (the capture rect no longer reaches past
// `pageH - mBottom` at all), so this no longer needs to double as a masking
// boundary and can stay modest.
let SAFETY_MARGIN_SHARED: CGFloat = 20

FileHandle.standardError.write(
    "page: \(Int(pageW/MM))x\(Int(pageH/MM))mm  margins t\(Int(mTop/MM)) r\(Int(mRight/MM)) b\(Int(mBottom/MM)) l\(Int(mLeft/MM))mm  column \(Int(contentW))x\(Int(contentH))pt\n"
        .data(using: .utf8)!)

_ = NSApplication.shared   // AppKit alive; no window is ever ordered

let web = WKWebView(frame: NSRect(x: 0, y: 0, width: pageW, height: pageH))

final class Paginator: NSObject, WKNavigationDelegate {
    let web: WKWebView
    let out: String
    let pageW: CGFloat, pageH: CGFloat
    let mTop: CGFloat, mRight: CGFloat, mBottom: CGFloat, mLeft: CGFloat
    let contentH: CGFloat

    /// y-offset (pt, from the top of the laid-out document) where each page starts.
    var breaks: [CGFloat] = []
    /// Total laid-out height of the document — the end of the LAST page's
    /// content, for the same per-page capture-height calculation that uses
    /// `breaks[i+1]` for every other page.
    var docHeight: CGFloat = 0

    init(web: WKWebView, out: String, pageW: CGFloat, pageH: CGFloat,
         mTop: CGFloat, mRight: CGFloat, mBottom: CGFloat, mLeft: CGFloat,
         contentH: CGFloat) {
        self.web = web; self.out = out
        self.pageW = pageW; self.pageH = pageH
        self.mTop = mTop; self.mRight = mRight; self.mBottom = mBottom; self.mLeft = mLeft
        self.contentH = contentH
    }

    func fail(_ message: String) -> Never {
        FileHandle.standardError.write("failed: \(message)\n".data(using: .utf8)!)
        exit(1)
    }

    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        // ── STEP 1: lay the document out inside the margin box ────────────────
        // The content column is a real inset, so long lines and wide tables WRAP
        // instead of being sliced at the right paper edge (BUG 1). The vertical
        // margins live on <body>'s padding so they travel with the content when
        // a page is translated into position.
        //
        // BUG 3 — TRAILING BLANK PAGES (2026-09-22). `createPDF` renders using
        // the same engine that answers `@media print` — it is WebKit's printing
        // path, not a plain screenshot. But `didFinish` fires in a normal,
        // un-printed page load, so `measureBlocks()` below was measuring block
        // positions under the SCREEN rules (17px body text) while `createPDF`
        // was later rasterising under the PRINT rules (10.5pt body text, tighter
        // leading). Every block's true, printed position was smaller than the
        // Y-coordinate it was measured at, so the page-packing loop scheduled
        // more pages than the printed content actually needed — and the pages
        // beyond where the real (smaller) content ended came back blank.
        // Forcibly widening the `@media print` rule to `all` — rather than
        // trying to make `createPDF` emulate screen media, which it doesn't —
        // makes the measurement pass see EXACTLY the rules the rasteriser will
        // use, because by the time this runs both passes are reading the same
        // now-unconditional rules.
        // BUG 9 — ALL THE HORIZONTAL MARGIN LANDED ON THE RIGHT (2026-09-23).
        // `body` was given a WIDTH (`contentW`) but no LEFT OFFSET, so it laid
        // out flush against the left paper edge at x=0 — every bit of the
        // horizontal margin (`mLeft + mRight`) ended up as blank space after
        // it, on the right, and none before it. The reported "we need more
        // left margin" was really "there is currently none": `mLeft` was
        // reserved in the page-size math but never actually applied to the
        // content's position. `positionFooterJs` DOES place the footer at
        // `left: mLeft` — correctly, per @page — which is what made the
        // mismatch visible: the footer looked off-centre only because the
        // body text beside it had no left inset to match.
        let setup = """
        (function(){
          var h=document.documentElement, b=document.body;
          h.style.margin='0';
          h.style.padding='0';
          h.style.width='\(pageW)px';
          b.style.margin='0';
          b.style.padding='0';
          b.style.marginLeft='\(mLeft)px';
          b.style.width='\(contentW)px';
          b.style.maxWidth='\(contentW)px';
          b.style.boxSizing='border-box';
          var s=document.createElement('style');
          s.textContent='img,svg,table,pre{max-width:100%!important}'
            + 'pre{white-space:pre-wrap!important;word-wrap:break-word!important}'
            + 'table{width:100%!important}';
          document.head.appendChild(s);
          // BUG 3: make every @media print rule unconditional, so measuring
          // (done here, under normal screen rules) sees the same layout
          // createPDF will rasterise (which honours @media print).
          for (var i=0;i<document.styleSheets.length;i++){
            var sheet=document.styleSheets[i];
            var rules;
            try { rules = sheet.cssRules; } catch(e) { continue; }
            if (!rules) continue;
            for (var j=0;j<rules.length;j++){
              var r=rules[j];
              if (r.media && r.conditionText === 'print') {
                r.media.mediaText = 'all';
              }
            }
          }
          return 1;
        })();
        """
        w.evaluateJavaScript(setup) { _, _ in
            // BUG 2's lesson: let the layout settle before measuring.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.measureBlocks()
            }
        }
    }

    /// ── STEP 2 + 3: measure blocks, then pack them into pages ─────────────
    func measureBlocks() {
        let js = """
        (function(){
          function top(el){var r=el.getBoundingClientRect();return r.top+window.scrollY;}
          function bot(el){var r=el.getBoundingClientRect();return r.bottom+window.scrollY;}
          var blocks=[];
          var main=document.querySelector('main')||document.body;
          var kids=main.children;
          for(var i=0;i<kids.length;i++){
            var el=kids[i];
            if(el.tagName==='TABLE'){
              // Measured as ONE block, like any other element, so a table
              // that fits on a page is never split just because it happens
              // to straddle where a page would otherwise have broken. Row
              // bounds are carried along too, but only USED as a fallback —
              // see the packing loop — for the rarer case of a table taller
              // than a full page, which has no choice but to break somewhere.
              var rows=el.querySelectorAll('tr'), rowBoxes=[];
              for(var r=0;r<rows.length;r++){
                rowBoxes.push({t:top(rows[r]),b:bot(rows[r])});
              }
              blocks.push({t:top(el),b:bot(el),tag:'table',rows:rowBoxes});
              continue;
            }
            var block={t:top(el),b:bot(el),tag:el.tagName.toLowerCase()};
            if(el.tagName==='PRE'){
              // Only used as a fallback (see the packing loop) for a code
              // block taller than a whole page — lets the break round to a
              // line boundary instead of a raw pixel offset through the
              // middle of a line of code.
              var lh=parseFloat(getComputedStyle(el).lineHeight);
              if(!isNaN(lh) && lh>0){ block.lineHeight=lh; }
            }
            blocks.push(block);
          }
          // The footer is pinned per page by the stylesheet, so it is not part
          // of the flow that gets packed.
          return JSON.stringify({blocks:blocks,
            height:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)});
        })();
        """
        web.evaluateJavaScript(js) { result, err in
            guard let json = result as? String,
                  let data = json.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let raw = obj["blocks"] as? [[String: Any]]
            else {
                self.fail("could not measure the document: \(String(describing: err))")
            }

            // BUG 7 — A TABLE ROW STILL CLIPPED INTO THE FOOTER (2026-09-22).
            // Even with FOOTER_RESERVE carving out the footer's own band,
            // one more row occasionally still crept past it: the measurement
            // above runs once, right after `setup()`'s style is applied, but
            // `createPDF`'s own print layout pass can rewrap a cell by a line
            // (sub-pixel column-width differences between the two passes,
            // same family of quirk as BUG 3's media mismatch) — enough to push
            // a row a few points below where it was measured. SAFETY_MARGIN is
            // a deliberately-cheap hedge against that drift: it costs a few pt
            // of whitespace at the foot of some pages and buys back the
            // guarantee that content never lands ON the footer.
            let usable = self.contentH - SAFETY_MARGIN_SHARED
            var pages: [CGFloat] = [0]
            var pageStart: CGFloat = 0

            // Packs one block [t,e) against the running page cursor. Shared by
            // the main loop and by the table fallback below, so a table's own
            // rows break with EXACTLY the same rule as everything else.
            func pack(_ t: CGFloat, _ e: CGFloat, _ tag: String, lineHeight: CGFloat? = nil) {
                let size = e - t
                let relStart = t - pageStart
                let relEnd = relStart + size

                if relEnd <= usable {
                    return                          // fits on the current page
                }
                // BUG 12 — A BLOCK TALLER THAN A PAGE ONLY OVERFLOWED WHEN IT
                // ALREADY STARTED A FRESH PAGE (2026-09-23). The oversize
                // branch below used to require `relStart <= 0` — true only
                // when this block was already the first thing on a page. A
                // block that starts PARTWAY down a page (the ordinary case:
                // some intro text runs before it) fell through to "break
                // before this block" instead, moved wholesale to a fresh
                // page, and was never checked again — so a block too tall
                // even for a page ALL TO ITSELF sailed through as if it fit.
                // Moving it to a fresh page here first, THEN falling into the
                // same oversize handling below with `relStart` now exactly
                // 0, is what makes the check unconditional.
                if relStart > 0 {
                    pageStart = t
                    pages.append(pageStart)
                }
                if size > usable {
                    // One block taller than a page — it has to overflow onto
                    // as many pages as it takes. A `WHILE`, not a single
                    // advance: a block taller than TWO pages used to only
                    // ever get one internal break, silently losing whatever
                    // came after the second page's worth (found alongside
                    // BUG 11 below, same test document).
                    FileHandle.standardError.write(
                        "note: a \(tag) block is taller than one page and will overflow\n"
                            .data(using: .utf8)!)
                    while pageStart + usable < e {
                        var advance = usable
                        // BUG 11 — AN OVERSIZED CODE BLOCK CAME BACK DUPLICATED,
                        // NOT SLICED (2026-09-23). `isolatePageJs` hides whole
                        // elements outside a page's range, which is correct for
                        // every block that fits somewhere whole — but a block
                        // taller than any single page is, by definition, on
                        // several pages AT ONCE, and there is no "whole
                        // element" page it belongs to. Rounding this break to
                        // a line boundary (below) is necessary but not
                        // sufficient; `isolatePageJs` also has to CROP the
                        // element to each page's slice instead of only ever
                        // showing all of it or none of it.
                        if let lh = lineHeight, lh > 0 {
                            let rawEnd = pageStart + usable
                            let linesIn = ((rawEnd - t) / lh).rounded(.down)
                            let rounded = t + max(linesIn, 1) * lh
                            if rounded > pageStart { advance = rounded - pageStart }
                        }
                        pageStart += advance
                        pages.append(pageStart)
                    }
                }
            }

            for b in raw {
                let t = CGFloat((b["t"] as? NSNumber)?.doubleValue ?? 0)
                let e = CGFloat((b["b"] as? NSNumber)?.doubleValue ?? 0)
                let tag = b["tag"] as? String ?? "?"
                let size = e - t

                // Tables are kept WHOLE unless the entire table is taller than
                // one page — the same "a block taller than a page must
                // overflow somewhere" case as any other block, just with rows
                // as the only sane place to put the break. A table that DOES
                // fit on a page is never split just because it straddled
                // where a page would otherwise have broken: it moves to the
                // next page complete, exactly like a paragraph or a heading
                // would.
                if tag == "table", size > usable, let rows = b["rows"] as? [[String: Any]] {
                    for row in rows {
                        let rt = CGFloat((row["t"] as? NSNumber)?.doubleValue ?? 0)
                        let re = CGFloat((row["b"] as? NSNumber)?.doubleValue ?? 0)
                        pack(rt, re, "tr")
                    }
                    continue
                }
                let lineHeight = (b["lineHeight"] as? NSNumber).map { CGFloat($0.doubleValue) }
                pack(t, e, tag, lineHeight: lineHeight)
            }

            self.breaks = pages
            let docHeight = CGFloat((obj["height"] as? NSNumber)?.doubleValue ?? 0)
            self.docHeight = docHeight
            FileHandle.standardError.write(
                "doc: \(Int(docHeight))pt tall -> \(pages.count) page(s)\n"
                    .data(using: .utf8)!)

            // BUG 10 — TOP AND BOTTOM OF EVERY PAGE PAST THE FIRST CLIPPED
            // (2026-09-23), investigated and ruled out here. The suspect was
            // `web`'s own frame being only one page tall while `cfg.rect`
            // (since BUG 4) asks `createPDF` for document coordinates far
            // outside it — resizing the webview's frame to the full document
            // height before capturing was tried and made no difference either
            // way. The actual cause was the DOM-mutating ghost-band mask (see
            // `maskGhostBand`'s comment, BUG 8) and is fixed there. `docHeight`
            // is kept only for the log line above.
            _ = docHeight
            self.renderPages(index: 0, collected: [])
        }
    }

    /// ── STEP 4: point the capture rect at each page's offset and rasterise ──
    ///
    /// BUG 4 — THE LAST PAGE (OR TWO) CAME BACK BLANK (2026-09-22). This used to
    /// shift the DOCUMENT with `transform:translateY()` and always capture the
    /// same `(0,0,pageW,pageH)` rect. That stopped working correctly a few pages
    /// in: a `transform` on `<html>` is a paint-time effect, and nothing here
    /// guarantees `createPDF` re-samples paint state the way a screenshot would
    /// — in practice, pages near the end of a long document collapsed onto one
    /// capture and the pages after it came back blank (still >1000 bytes, so
    /// the emptiness guard below didn't catch it — the PDF machinery itself
    /// isn't empty, just the visible content is).
    ///
    /// `WKPDFConfiguration.rect` is documented as a rect INTO THE DOCUMENT, not
    /// a post-paint crop of the viewport — so moving `rect.origin.y` instead of
    /// moving the document is both simpler and the actually-correct use of the
    /// API. No transform, no paint-timing race.
    ///
    /// Moving the capture instead of the document has one consequence: a
    /// `position:fixed` footer no longer rides along "for free" the way it did
    /// (or was meant to) under the transform, so `positionFooter` below places
    /// it explicitly for whichever page is about to be captured.
    ///
    /// BUG 5 — NO TOP MARGIN, AND THE FOOTER COLLIDING WITH CONTENT (2026-09-22).
    /// `setup()` zeroes `<body>`'s padding so the CONTENT COLUMN's width is
    /// exact (BUG 1), which means the measured "t"/"b" of every block is in
    /// coordinates where the document starts at y=0 — there is no top margin
    /// IN THE FLOW. `breaks[i]` is a content-flow position, not a page-of-paper
    /// position. Capturing `rect.origin.y = breaks[i]` therefore put page i's
    /// content flush against the TOP paper edge with no margin above it, and
    /// let it run all the way down to the bottom paper edge too — the packer
    /// only ever reserved `contentH` (`pageH - mTop - mBottom`) of content per
    /// page, but that budget was never actually POSITIONED inside the margin
    /// box, so a nearly-full page pushed its last line down far enough to
    /// collide with the footer sitting at `pageH - mBottom`.
    /// Subtracting `mTop` from the capture origin re-centres the same
    /// `contentH`-tall budget inside the page: content that starts the page at
    /// `breaks[i]` now lands at relative y=`mTop`, and whatever the packer left
    /// unused is blank margin at the bottom, same as every other page — the
    /// margin box finally means what @page says it means.
    func renderPages(index: Int, collected: [Data]) {
        if index >= breaks.count {
            merge(collected)
            return
        }
        // The top of THIS PAGE OF PAPER, not the top of this page's content —
        // the content starts `mTop` further down, inside the margin box.
        let pageOrigin = breaks[index] - mTop
        let nextBreak = index + 1 < breaks.count ? breaks[index + 1] : docHeight

        // BUG 8 — THE NEXT PAGE GHOSTING IN (2026-09-22/23), fixed at the
        // root after three narrower attempts each failed for a different
        // reason:
        //   1. A white DOM `<div>` inserted before each capture, to cover the
        //      excess. Made things WORSE — it triggered a WebKit compositing
        //      bug that silently dropped unrelated content on LATER pages (a
        //      heading missing its top half, a code block missing everything
        //      past its first line). Bisected by re-running the same document
        //      with only the insertion removed: the missing content came
        //      back, so the div itself was the trigger.
        //   2. A CoreGraphics rectangle painted over the FINISHED page,
        //      post-capture. Fought the footer for the same pixels — mask
        //      short enough to spare the footer, and a large enough ghost
        //      still peeked out beneath it; mask long enough to catch every
        //      ghost, and it painted over the footer instead.
        //   3. Shrinking `cfg.rect`'s height to this page's own measured
        //      content span, plus a fixed cushion for measurement drift
        //      (`SAFETY_MARGIN_SHARED`) and room for the footer. Closer, but
        //      the cushion IS capture height — when the drift it defends
        //      against doesn't happen (the common case, especially right
        //      after the packer breaks early because the NEXT block didn't
        //      fit), that cushion is real DOM belonging to the next page, and
        //      `createPDF` paints exactly that: a reproducible sliver of the
        //      wrong page under the footer on almost every page that broke
        //      early.
        //
        // None of these fixed the actual cause: capturing a rect that
        // OVERLAPS real, laid-out DOM which doesn't belong to this page will
        // always risk painting it, no matter how the rect's edges are
        // computed after the fact. So this doesn't shrink the rect at all —
        // it hides the DOM instead. `isolatePageJs` sets `visibility:hidden`
        // (never `display:none`, which would reflow everything after it and
        // invalidate every position `measureBlocks` already computed) on
        // every top-level block — and every table row — outside this page's
        // own `[breaks[index], nextBreak)` span, right before the capture.
        // With nothing else there to paint, the capture rect can safely stay
        // the full `pageH - mBottom` again, the footer can go back to one
        // fixed offset, and no per-page arithmetic has to get this exactly
        // right for the fix to hold.
        web.evaluateJavaScript(isolatePageJs(from: breaks[index], to: nextBreak)) { _, _ in
            self.web.evaluateJavaScript(self.positionFooterJs(forPageOrigin: pageOrigin, page: index + 1, of: self.breaks.count)) { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    let cfg = WKPDFConfiguration()
                    cfg.rect = CGRect(x: 0, y: pageOrigin, width: self.pageW, height: self.pageH - self.mBottom)
                    self.web.createPDF(configuration: cfg) { result in
                        switch result {
                        case .success(let data):
                            // A blank page is a silent failure, and a silent
                            // failure is the one thing this tool must never have.
                            if data.count < 1000 {
                                self.fail("page \(index + 1) came out nearly empty "
                                    + "(\(data.count) bytes) — nothing useful would print")
                            }
                            var next = collected
                            next.append(self.finishPage(data))
                            self.renderPages(index: index + 1, collected: next)
                        case .failure(let e):
                            self.fail("page \(index + 1): \(e)")
                        }
                    }
                }
            }
        }
    }

    /// Hides every top-level `<main>` child, and every table row, whose
    /// measured position falls outside `[lo, hi)` — the same coordinates
    /// `measureBlocks` already computed, so this makes no new layout
    /// decisions of its own. `visibility:hidden` rather than `display:none`:
    /// the element still occupies its box and every later sibling's position
    /// is unaffected, which matters because this runs again, with a new
    /// range, before every remaining page — a reflow here would invalidate
    /// `breaks` for all of them at once.
    func isolatePageJs(from lo: CGFloat, to hi: CGFloat) -> String {
        return """
        (function(){
          function top(el){var r=el.getBoundingClientRect();return r.top+window.scrollY;}
          function bot(el){var r=el.getBoundingClientRect();return r.bottom+window.scrollY;}
          // BUG 11 — AN OVERSIZED CODE BLOCK CAME BACK DUPLICATED, NOT SLICED
          // (2026-09-23). A `visibility:hidden`-or-not toggle is all-or-
          // nothing per element: correct for every block small enough to
          // belong to exactly one page, wrong for a block taller than any
          // single page, which by definition is straddling several at once.
          // Toggling only visibility showed such a block FULLY on every page
          // its range overlapped — the same code from line 1 repeated on
          // each one, clipped only by chance where the page's own edge fell.
          // A partial overlap gets `clip-path` instead: it crops the element
          // to just the slice belonging to THIS page, without moving or
          // resizing its box (so nothing else's measured position shifts).
          function isolate(el, t, b){
            if (b <= \(lo) || t >= \(hi)) {
              el.style.visibility = 'hidden';
              el.style.clipPath = 'none';
              return;
            }
            el.style.visibility = 'visible';
            var topInset = Math.max(\(lo) - t, 0);
            var bottomInset = Math.max(b - \(hi), 0);
            el.style.clipPath = (topInset > 0 || bottomInset > 0)
              ? 'inset(' + topInset + 'px 0 ' + bottomInset + 'px 0)'
              : 'none';
          }
          var main = document.querySelector('main');
          if (!main) { return 0; }
          var kids = main.children;
          for (var i=0;i<kids.length;i++){
            var el = kids[i];
            if (el.tagName === 'TABLE') {
              var rows = el.querySelectorAll('tr');
              for (var r=0;r<rows.length;r++){
                isolate(rows[r], top(rows[r]), bot(rows[r]));
              }
              el.style.visibility = 'visible';
              el.style.clipPath = 'none';
              continue;
            }
            isolate(el, top(el), bot(el));
          }
          return 1;
        })();
        """
    }

    /// Places `.page-footer` at the foot of the page whose PAPER (not content)
    /// top, in document-space, is `pageOrigin` — i.e. plain in-flow
    /// `position:absolute`, so it is wherever `renderPages` is about to point
    /// the capture rect — not wherever a `position:fixed` viewport happens to
    /// think "the viewport" is once the capture is no longer a simple
    /// top-of-page screenshot.
    func positionFooterJs(forPageOrigin pageOrigin: CGFloat, page: Int, of total: Int) -> String {
        // Just below the content band (`mTop + contentH`), inside the margin
        // reserved for it by FOOTER_RESERVE — not at `pageH - mBottom`, which
        // is where a fully-packed page's own last line also lands. Safe to
        // use this fixed offset on every page regardless of how little of
        // `contentH` a given page actually used: `isolatePageJs` guarantees
        // nothing but this page's own content can paint above it, so there is
        // no ghost left to reach for the same pixels.
        let top = pageOrigin + mTop + contentH + 8
        return """
        (function(){
          var f = document.querySelector('.page-footer');
          if (!f) { return 0; }
          f.style.position = 'absolute';
          f.style.top = '\(top)px';
          f.style.bottom = 'auto';
          f.style.left = '\(mLeft)px';
          f.style.right = 'auto';
          f.style.width = '\(pageW - mLeft - mRight)px';
          f.style.display = 'block';
          var p = f.querySelector('.pf-page');
          if (p) { p.textContent = 'Page \(page) of \(total)'; }
          return 1;
        })();
        """
    }

    /// Pads a `(pageH - mBottom)`-tall capture (see BUG 8's fix in
    /// `renderPages`) back out to a full A4 `pageH` sheet — blank below the
    /// footer, which is exactly where the bottom margin always was. Every
    /// page in the merged PDF ends up with the same real MediaBox this way;
    /// nothing downstream (Preview, a print driver, `pdfinfo`) can tell this
    /// page was ever captured any shorter than the rest.
    func finishPage(_ pageData: Data) -> Data {
        guard let srcDoc = PDFDocument(data: pageData), let srcPage = srcDoc.page(at: 0)
        else { return pageData }

        // The FULL page size must be set on the CONTEXT (via this pointer),
        // not in beginPDFPage's info dictionary — a `kCGPDFContextMediaBox`
        // entry there needs the CGRect wrapped as NSData, and passing the
        // struct directly is accepted without error but silently ignored,
        // which is how a first attempt at this quietly turned every page US
        // Letter instead of A4 (BUG 1 all over again, at the very end of the
        // pipeline this time).
        var box = CGRect(x: 0, y: 0, width: pageW, height: pageH)
        let out = NSMutableData()
        guard let consumer = CGDataConsumer(data: out as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil)
        else { return pageData }

        ctx.beginPDFPage(nil)
        // The capture's own top must land at the FULL page's top (`pageH`).
        // Translating up by `pageH - captureHeight` does that — reading the
        // ACTUAL captured page's own height back from its MediaBox, rather
        // than assuming the fixed `pageH - mBottom` of an earlier version,
        // because `renderPages` now sizes the capture to each page's own
        // content span and it is almost never that constant.
        let captureHeight = srcPage.bounds(for: .mediaBox).height
        ctx.translateBy(x: 0, y: pageH - captureHeight)
        srcPage.draw(with: .mediaBox, to: ctx)
        ctx.endPDFPage()
        ctx.closePDF()
        return out as Data
    }

    /// ── STEP 5: merge with PDFKit ─────────────────────────────────────────
    ///
    /// PDFKit ships with macOS, so this is a native operation rather than a
    /// second file-format implementation to maintain. It also means each page
    /// keeps its own MediaBox and the result is a PDF that CoreGraphics, Preview
    /// and every printer driver will accept.
    func merge(_ pages: [Data]) {
        if pages.isEmpty {
            fail("nothing was rendered")
        }

        let merged = PDFDocument()
        var inserted = 0

        for (i, data) in pages.enumerated() {
            guard let doc = PDFDocument(data: data), doc.pageCount > 0 else {
                fail("page \(i + 1) could not be read back as a PDF")
            }
            for p in 0..<doc.pageCount {
                guard let page = doc.page(at: p) else { continue }
                merged.insert(page, at: inserted)
                inserted += 1
            }
        }

        if inserted == 0 {
            fail("no pages were produced")
        }
        guard merged.write(to: URL(fileURLWithPath: out)) else {
            fail("could not write \(out)")
        }

        let size = (try? FileManager.default.attributesOfItem(atPath: out)[.size] as? Int) ?? 0
        FileHandle.standardError.write(
            "pdf: \(size ?? 0) bytes, \(inserted) page(s) -> \(out)\n".data(using: .utf8)!)
        exit(0)
    }
}

let paginator = Paginator(web: web, out: outPath,
                          pageW: pageW, pageH: pageH,
                          mTop: mTop, mRight: mRight, mBottom: mBottom, mLeft: mLeft,
                          contentH: contentH)
web.navigationDelegate = paginator
web.loadFileURL(URL(fileURLWithPath: inPath),
                allowingReadAccessTo: URL(fileURLWithPath: inPath).deletingLastPathComponent())
RunLoop.main.run()
