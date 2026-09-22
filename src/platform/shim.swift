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
let contentH = pageH - mTop - mBottom

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
        let setup = """
        (function(){
          var h=document.documentElement, b=document.body;
          h.style.margin='0';
          h.style.padding='0';
          h.style.width='\(contentW)px';
          b.style.margin='0';
          b.style.padding='0';
          b.style.width='\(contentW)px';
          b.style.maxWidth='100%';
          b.style.boxSizing='border-box';
          var s=document.createElement('style');
          s.textContent='img,svg,table,pre{max-width:100%!important}'
            + 'pre{white-space:pre-wrap!important;word-wrap:break-word!important}'
            + 'table{width:100%!important}';
          document.head.appendChild(s);
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
              // Measured row by row so a long table breaks BETWEEN rows.
              var rows=el.querySelectorAll('tr');
              for(var r=0;r<rows.length;r++){
                blocks.push({t:top(rows[r]),b:bot(rows[r]),tag:'tr'});
              }
              continue;
            }
            blocks.push({t:top(el),b:bot(el),tag:el.tagName.toLowerCase()});
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

            let usable = self.contentH
            var pages: [CGFloat] = [0]
            var pageStart: CGFloat = 0

            for b in raw {
                let t = CGFloat((b["t"] as? NSNumber)?.doubleValue ?? 0)
                let e = CGFloat((b["b"] as? NSNumber)?.doubleValue ?? 0)
                let tag = b["tag"] as? String ?? "?"
                let size = e - t
                let relStart = t - pageStart
                let relEnd = relStart + size

                if relEnd <= usable {
                    continue                       // fits on the current page
                }
                if relStart <= 0 && size > usable {
                    // One block taller than a page — it has to overflow. Say so
                    // rather than looping forever.
                    FileHandle.standardError.write(
                        "note: a \(tag) block is taller than one page and will overflow\n"
                            .data(using: .utf8)!)
                    pageStart += usable
                    pages.append(pageStart)
                    continue
                }
                // Break BEFORE this block, so it is never sliced in half.
                pageStart = t
                pages.append(pageStart)
            }

            self.breaks = pages
            FileHandle.standardError.write(
                "doc: \(Int((obj["height"] as? NSNumber)?.doubleValue ?? 0))pt tall -> \(pages.count) page(s)\n"
                    .data(using: .utf8)!)

            self.renderPages(index: 0, collected: [])
        }
    }

    /// ── STEP 4: translate to each page and rasterise exactly one A4 page ──
    func renderPages(index: Int, collected: [Data]) {
        if index >= breaks.count {
            merge(collected)
            return
        }
        let shift = breaks[index]
        let js = "document.documentElement.style.transform='translateY(\(-shift)pt)';1;"
        web.evaluateJavaScript(js) { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                let cfg = WKPDFConfiguration()
                // EXACTLY one page, at the real page size. Everything is already
                // positioned by the translate above.
                cfg.rect = CGRect(x: 0, y: 0, width: self.pageW, height: self.pageH)
                self.web.createPDF(configuration: cfg) { result in
                    switch result {
                    case .success(let data):
                        // A blank page is a silent failure, and a silent failure
                        // is the one thing this tool must never have.
                        if data.count < 1000 {
                            self.fail("page \(index + 1) came out nearly empty "
                                + "(\(data.count) bytes) — nothing useful would print")
                        }
                        var next = collected
                        next.append(data)
                        self.renderPages(index: index + 1, collected: next)
                    case .failure(let e):
                        self.fail("page \(index + 1): \(e)")
                    }
                }
            }
        }
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
