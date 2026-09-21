# mdprint — build spec (v1, 2026-09-21)

**One line:** right-click a markdown file, get a properly typeset page out of your printer.
No browser, no preview, no "Save as PDF then find the file then open it then hit Cmd-P".

- **Status:** spec. No code in this repo yet — build happens in a follow-up goal.
- **Target:** VS Code extension (works in Cursor unchanged).
- **Language:** TypeScript for the extension. **Python is not used at any point** — not in
  the extension, not in the build, not in the tests. It cannot be assumed to exist on a
  user's machine, and on the platforms this is aiming at it often won't. The only non-TS
  code is the macOS Swift shim (§7), which is an OS framework wrapper, not a runtime
  dependency.
- **Alpha platform:** macOS. Windows/Linux are additive classes, not edits.
- **Author of the original POC:** Jaymeh + Kai (Hermes). This spec ports a *proven* pipeline, not a guess.
- **Tests:** TypeScript, golden HTML fixtures. **Python is not used anywhere** — not at
  runtime, not at build, not at test. It may not exist on a user's machine.

---

## 1. Why this exists

Markdown files get generated constantly (Cursor, Claude, notes, READMEs) and reading them
on screen is worse than on paper: you skim, you scroll, you get distracted. The existing
tools get you *close* — export to PDF, print from the editor — but every one of them inserts
a detour. The detour is the problem.

**The test every decision in this spec has to pass:** *is this easier than the faff, or will it
just not get used?*

It is explicitly **not** an editor, **not** a markdown preview, and **not** a markdown
renderer. Plenty of those exist and are better than anything we'd write. The entire value
here is **print layout** — what it looks like on a sheet of A4.

---

## 2. What already works (the POC, and why this port is low-risk)

A working pipeline was built and **proven with real paper** on 2026-09-21 (HP Smart Tank
7000, job `HP_SmartTank-5`, 27648 bytes, sheet came out). The logic is done. This repo is a
**port**, not a research project.

```
.md  ->  styled HTML  ->  PDF (offscreen WebKit)  ->  lp  ->  printer
```

POC line counts, so the size of the port is honest. **The POC was a proof, not a
foundation** — every line of it is rewritten in TypeScript or dropped. Nothing from it
ships, and nothing from it is needed to build or test this project:

| POC file | Lines | What happens to it |
|---|---|---|
| `mdprint.py` — markdown → HTML renderer | 256 | **rewritten** in TypeScript |
| `mdprint.css` — the print stylesheet | 294 | **copied verbatim** into a TS string constant |
| `printplatform.py` — the printer interface | 342 | **rewritten** as TS interfaces + one class per OS |
| `mdprint_cli.py` — the CLI rail | 193 | **absorbed** into the extension's commands |
| `shim.swift` — offscreen HTML → PDF | 67 | **rewritten** as Swift for macOS (see §7) |

**~1,150 lines of POC, of which only the CSS is copied rather than rewritten.** That is the
whole reason this port is low-risk: the *logic* is proven on real paper, and logic survives
a language change. The POC itself is discarded.

### The five things the POC learned the hard way

These are not nice-to-haves. Each one was a real bug that produced a bad sheet:

1. **`WKWebView.createPDF` ignores `@page`.** Page size and margins must be set
   explicitly by the converter, or every sheet silently comes out US Letter.
   *(A4 verified: 209.9 × 296.7 mm.)*
2. **Content overran the right paper edge.** The converter was laying out at full page
   width with no margins reserved. Fixed by insetting the content box to the `@page`
   margins — **not** by shrinking the paper, which is what the first attempt did and
   made it worse (it produced a 179.9 mm-wide page).
3. **Only page 1 printed.** Fixed with an explicit `display:block` in `@media print`.
4. **Collapsed `<details>` printed empty.** Replaced with a plain `[hidden]` div.
5. **Dark mode printed the wrong colours.** Tokens pinned to light inside
   `@media print :root {}`.

Plus: **code blocks must wrap, not bleed off the page** (`pre { white-space: pre-wrap }`
under `@media print`), and **`@page :left`/`:right` margins get roomier inner edges** for
stapling.

**Everything in this section must survive the port bit-for-bit.** It is the actual product.

---

## 3. The architecture rule

This is Jaymeh's own framing and it governs the whole codebase:

> *"…a new class based system for each OS. Just gets detected and uses the right class
> derived from an interface of sorts."*

**One interface. One class per OS. Detection picks the class at runtime. Everything above
the interface is platform-blind.**

The test for whether the seam is right: **adding Windows must mean adding one file, and
editing nothing.** If a platform change touches anything outside its own class, the seam
is wrong and needs fixing before the platform gets added.

```
                 ┌──────────────────────────────────────────┐
   UI layer      │  commands · settings · pickers           │  never mentions an OS
                 └────────────────────┬─────────────────────┘
                                      │ PrintPlatform (interface)
                 ┌────────────────────┴─────────────────────┐
                 │  detect() -> PrintPlatform               │   factory, not a branch
                 └───────┬──────────────┬──────────────┬────┘
                 ┌───────┴────┐  ┌──────┴─────┐  ┌─────┴──────┐
                 │ MacPlatform│  │ WinPlatform│  │ LinuxPlat. │
                 │  (alpha)   │  │ (later)    │  │  (later)   │
                 └────────────┘  └────────────┘  └────────────┘
```

The interface has **exactly four operations**. That is a deliberate ceiling — every method
is one a future platform must implement on a machine nobody on this project owns.

```ts
interface PrintPlatform {
  readonly displayName: string;                    // "macOS" | "Windows" | "Linux"
  isAvailable(): Promise<boolean>;                 // is the print system there at all
  listPrinters(): Promise<Printer[]>;              // the OS's OWN list
  print(pdfPath: string, job: PrintJob): Promise<string>;   // returns job id
  openPrintDialog(pdfPath: string): Promise<void>; // hand off to the OS dialog
}
```

### We inherit printers, we don't manage them

Every OS already has a printer list the user configured. **We read theirs.** We never
install a driver, never set up a queue, never keep our own registry of devices.

- macOS / Linux → `lpstat -e`, `lpstat -d`, `lpoptions -p NAME -l`
- Windows → `Get-Printer` (PowerShell, ships with the OS)

Note this is why "the user's installed printers" works across devices for free.

---

## 4. The line we do not cross: it is not a print driver

Duplex is a **flag**. Stapling is a **driver**.

```ts
interface PrintJob {
  printer: string;
  copies: number;
  duplex?: 'one-sided' | 'two-sided-long-edge' | 'two-sided-short-edge';
  pageRange?: string;      // "1-4,7"
  // !! THE CEILING IS HERE !!
  // Adding `staple`, `tray`, `fold` or `punch` to this interface means the
  // project has become a print driver and has lost.
}
```

**The test before adding any field:**
- A flag every OS exposes the same way (duplex, copies, page range, media size)
  → **field**. Cheap and honest.
- A per-model capability with model-specific names (stapling, punching, folding,
  tray selection) → **not a field**. Open the OS dialog.

The reasoning is concrete, not philosophical. The HP Smart Tank exposes **five** options
total — modellable. An office laser exposes **sixty**, with different names per
manufacturer, and maintaining that is an infinite job. **The OS dialog is how you get all
of it for free, forever.**

**The dialog is a door, not a fallback.** The one-click path never fails over to it. It is
a second, deliberate exit the user picks when they want to fiddle. This matters: it keeps
the "one clean pipeline, no fallback" house rule intact while still covering the long tail.

### Never silently improve on the user's own setup

Measured fact: `HP_SmartTank` **supports** duplex but its queue **defaults to**
`*None`. So "duplex is sensible, turn it on" would override a deliberate hardware
setting. Therefore:

- Omitted `--sides` → **we send no `sides` flag at all.** The printer's own default wins.
- Explicitly asking for something the hardware can't do → **fail loud**, never a silently
  ignored flag.

---

## 5. Capture a setting once, then remember it

Direct instruction: settings chosen in the print dialog should be **saved against the
printer**, and the scope should be **global** — the reasoning being that a printer is a
device attached to the machine, not a property of a workspace or a file.

- Key: `mdprint.printerSettings.<printerName>`
- Value: `{ duplex?, copies?, ... }` — the same shape as `PrintJob`
- Stored in VS Code's **global** configuration (not workspace, not folder)
- Per-printer, because that is how people actually think about it ("my laser duplexes,
  the little inkjet doesn't")

One rule: **a saved setting is a default, never a lock.** If the saved duplex is
unavailable on the printer right now, say so and print the safe way — do not fail the job
over a preference.

---

## 6. Trigger surface

Confirmed: **right-click a file in the Explorer** and **the command palette when we detect
we're in a markdown file**.

| Surface | Behaviour |
|---|---|
| Explorer right-click on a `.md` | `mdprint: Print` (+ `mdprint: Print with options…`) |
| Command palette, in a `.md` | same two commands |
| Command palette, not in a `.md` | commands hidden (`when` clause) — don't offer what can't work |
| Editor title bar | optional, low cost, likely worth it |

**Unsaved buffers print.** Direct instruction: *"I shouldn't have to save the file to do
it."* So the renderer takes the editor's **in-memory text**, not the file on disk. This is
one of the few places the extension beats the CLI outright — it sees the live document.
Right-clicking a file in the Explorer obviously uses that file from disk instead.

---

## 7. The one native piece — the shim

Everything ports to TypeScript **except** HTML → PDF. There is no HTML→PDF engine in Node
that does a good job without dragging in a browser.

The POC solved this the right way: **macOS's own web engine, offscreen.**

- A ~67-line Swift binary using `WKWebView` + `createPDF`
- No window, no tab, no browser UI, **no Chrome dependency**
- The browser is real but *invisible* — the engine Safari uses, with no UI attached
- This answers the original objection (*"the idea that we open up a web browser just to
  print is a bit meh"*). The detour is gone; the engine stayed.
- Loads from **`file://`** — `data:` URLs *hang* the web view (learned the hard way, exit
  124 with no error)
- Must **explicitly set page size and margins** from the document's `@page` (see §2.1)

**Why it can't be TypeScript:** the Node alternatives all mean shipping a browser. That's a
~150 MB dependency for a print button — against the fewest-dependencies rule. So this is the
one seam where we stop fighting the language and use the OS.

**And it's why alpha is macOS-only.** Not a limitation being dodged — just the piece that
has to be written per OS. Windows would be the same idea via Edge WebView2: same shape,
different class, no change above the interface.

**Question the build must answer:** prebuilt binary in the VSIX, or build on first run?
Building on first run keeps the extension tiny and avoids shipping a binary we can't
notarise per architecture; it costs a few seconds once. **Recommendation: build on first
run, cache it, and fail with one honest line if Xcode CLT is missing.**

**Test coverage:** deliberately excluded from unit tests. Mocking WKWebView tests the mock.
It's covered by the manual checklist in §9a instead.


---

## 8. Alpha scope

**In:**
- macOS only (one class; the interface is built so the second class is additive)
- Print to a chosen printer, one click
- The options screen — printer picker, single/double-sided, copies, page range
- The dialog door (`Print with options…`)
- Global per-printer remembered settings
- Explorer + palette + unsaved buffers

**Out (explicitly, for alpha):**
- Windows and Linux classes (the seam exists; the class doesn't)
- Print preview
- Any per-model option modelling (see §4 — permanently out, not just deferred)
- Publishing to the marketplace (do that once it's proven on Jaymeh's Mac)

---

## 9. Build order

Later steps must not require redoing earlier ones. Each step ends in something runnable.

1. **Scaffold.** `yo code` TypeScript extension, VS Code engine + Cursor verified.
   Ends: command appears in the palette and prints a line to the output channel.
2. **Port the CSS.** `mdprint.css` → a TS string constant, verbatim. Ends: a snapshot test
   asserting the `@page` block and the four print rules survive.
3. **Port the renderer.** `mdprint.py` → TypeScript. Ends: **`npm test` green against the
   golden HTML fixtures** (see §9a).
4. **The platform interface + `MacPlatform`.** `detect()`, `listPrinters()`, `print()`,
   `openPrintDialog()`, `PrintError`. Ends: `mdprint: Print` produces real paper.
5. **Unsaved buffers.** Render from the live document, not disk. Ends: print a dirty buffer.
6. **Options screen + settings.** QuickPick flow + global per-printer storage. Ends: choice
   is remembered across restarts.
7. **Dialog door.** `Print with options…`. Ends: PDF handed to the OS dialog.

---

## 9a. Test strategy — golden fixtures

The port's risk is not "does it compile", it is **"did the TS renderer quietly drift from
the behaviour we proved on real paper"**. So the tests are built around **golden HTML
fixtures**: known markdown in, known-good HTML out, committed to the repo.

### The rule that makes this work

**Python is not used anywhere in this project** — not at runtime, not at build, not at
test. It cannot be assumed present on a user's machine, so nothing may depend on it.

The POC's HTML output was captured **once**, by hand, and committed as fixtures. From then
on **the fixtures are the source of truth.** They are plain text files in the repo; reading
them requires nothing but Node.

```
test/fixtures/
  <case>.md          input markdown
  <case>.html        the expected rendered HTML   <- the golden
```

A fixture is only ever regenerated **deliberately, with a reason, and reviewed** — never
to make a red test go green. If the diff isn't understood, the fixture doesn't change.

### Fixture cases — each one exists because it broke once

One fixture per line in §2, so every bug we paid for in paper has a test standing over it:

| Fixture | Guards against |
|---|---|
| `basic.md` | the whole pipeline, sanity |
| `frontmatter.md` | YAML title parsing, title fallback from filename |
| `page-width.md` | **the right-edge clip** — long paragraphs must wrap |
| `code-bleed.md` | code blocks must not run off the page |
| `mixed-blocks.md` | headings, lists, tables, blockquotes in one doc |
| `details.md` | collapsed `<details>` must not print empty |
| `table-wide.md` | tables stay put, cells wrap |

### Test layers

1. **Unit — renderer.** `render(md)` vs fixture HTML. Plain string compare; failures print
   a diff so a drift is readable, not a boolean.
2. **Unit — CSS invariants.** Assert the four earned rules are present **as strings** in the
   compiled CSS constant, with a comment saying *why* each is load-bearing:
   - the `@page` block exists (page size + margins)
   - `pre` wraps under `@media print` (code bleed)
   - `display:block` under `@media print` (page-1-only bug)
   - light tokens pinned in `@media print :root` (dark-mode bug)

   This is a cheap test that catches the single most likely refactor accident: someone
   "tidying" the stylesheet and deleting the fix.
3. **Unit — `PrintJob` → argv.** Pure function, no printer. Asserts the **faithful
   defaults** rule: when `duplex` is unset, the built argv **contains no `sides` flag at
   all** (so the printer's own default wins — see §4).
4. **Unit — `detect()`.** Returns the platform class, given the test platform. This is the
   seam's own test: it proves a second class could be selected.

### Deliberately NOT unit-tested

- **The Swift shim.** It's ~67 lines wrapping OS frameworks; mocking WKWebView tests the
  mock. It's covered by the manual checklist instead.
- **Real printing.** Tests never send a job to a printer. Per the no-wasted-paper rule, a
  dry run answers everything a test could.

### Manual checklist — the part CI can't prove

Run before any alpha tag, on a real Mac with real paper:

1. Print a document → sheet comes out A4, not Letter.
2. Check the **right margin** — nothing clipped.
3. Print a 3-page doc → all three pages, page 3 not blank.
4. Print a doc with a code block → code wraps, doesn't bleed.
5. Print with dark mode enabled → sheet is light, not inverted.
6. Print a **dirty (unsaved)** buffer → prints the edited text.
7. Try a printer needing auth → **fails loud and specific**, queue not left stalled.
8. Ask for duplex on a single-sided printer → refuses explicitly, doesn't silently ignore.


---

## 10. House rules carried into this repo (non-negotiable)

1. **One clean pipeline, no fallback.** Two paths for the same job create confusion. The
   dialog door is a *door the user chooses*, not a second path the code falls back to.
2. **Fail loud and specific.** The HP required Digest auth and "lied by silence" — jobs sat
   in the queue looking like a dead network. So: *"this printer wants a username and
   password; add it in System Settings"*, never a job that looks stuck.
3. **No wasted paper.** Never send a job to verify something a dry run could check.
4. **Never print somewhere the user didn't ask for.** A named printer that has vanished is
   an error, never a silent redirect to the default.
5. **Fewest dependencies possible.** The POC ended at zero — `swiftc` and the OS's own
   tools. Hold that line.
