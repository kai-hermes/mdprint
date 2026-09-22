# mdprint

Right-click a markdown file, get a properly typeset page. VS Code / Cursor extension.

The value here is print layout, not markdown rendering. It is not an editor, not a
preview, and not another markdown renderer.

```
.md  ->  styled HTML  ->  PDF (offscreen web engine)  ->  printer
```

No browser opens. No dialog unless you ask for one. Works on unsaved files.

- **Status:** works on macOS. Built, tested, and packages into a `.vsix`.
- **Alpha:** macOS
- **Language:** TypeScript (plus one native helper — see [The shim](#the-shim))
- **Architecture:** one interface, one class per OS, runtime detection
- **Not:** a print driver. Duplex is a flag; stapling is the OS's job.

---

## Install

### 1. Prerequisite: Xcode Command Line Tools

mdprint builds its PDF converter on first use, which needs `swiftc`. Check:

```bash
xcode-select -p        # prints a path if installed
```

If that errors, install them (a few hundred MB, one time):

```bash
xcode-select --install
```

The extension checks for this **before** it tries to build, so if it's missing you get
one clear sentence instead of a confusing crash.

### 2. Build the extension

```bash
git clone https://github.com/kai-hermes/mdprint.git
cd mdprint
npm install
npm run build
```

`npm install` pulls exactly one dependency (TypeScript, a dev dependency). There is no
runtime dependency at all.

### 3. Package it

```bash
npx @vscode/vsce package
```

That writes `mdprint-0.0.1.vsix` (23 files, ~62 KB). No Marketplace account, no signing,
no review — for personal use you install the file directly.

You should **not** see a license prompt. If you do, a `LICENSE` file has gone missing —
add it back rather than answering `y`. `--skip-license` silences the warning by shipping
an unlicensed package, which is the opposite of what you want. `packaging.test.ts` fails
if the file disappears or if `.vscodeignore` starts excluding it.

### 4. Install into VS Code or Cursor

The most reliable route on macOS — the `code` and `cursor` CLIs are often not on your
PATH. From the editor: **Extensions → `⋯` menu → Install from VSIX…** → pick
`mdprint-0.0.1.vsix`. Reload the window when prompted.

If you do have the CLI installed (*Shell Command: Install 'code' command in PATH*):

```bash
code   --install-extension mdprint-0.0.1.vsix
cursor --install-extension mdprint-0.0.1.vsix
```

### 5. First run

Open any `.md` file, right-click it, choose **Print**. The first print takes an extra
few seconds because the PDF converter is compiled once. Every print after that is
immediate. The build is cached, keyed on a hash of the converter source — so it
survives restarts and only rebuilds if that source actually changes.

---

## Use

Five commands, available from the Explorer right-click, the editor tab right-click, and
the Command Palette (when a markdown file is active):

- **mdprint: Print** — render, then ask which printer and which sides, then print. One
  click to a sheet of paper.
- **mdprint: Print with dialog…** — render, then hand the PDF to your system print
  dialog. Every driver option mdprint deliberately refuses to model lives in there.
- **mdprint: Customise template for this item…** — open a live stylesheet for the
  document you're looking at. What you see is what prints.
- **mdprint: Choose printer for this document…** — pick a printer without printing.
- **mdprint: Save as PDF…** — no printer involved. Useful for checking layout.

**The printer list includes "Save as PDF…".** When mdprint asks where the document
should go, the PDF row is one of the answers — so you can render a document you're
happy with and keep it, without a printer being involved at all. It appears whether or
not you have any printers, which is the point: the machine with no printer is the one
that most wants a PDF.

Choosing it opens a save dialog with the PDF already written, so the file you get is
byte-for-byte what would have been printed. Picking a name that already exists asks
before replacing it rather than overwriting in silence.

**Unsaved buffers work.** Press it with unsaved edits and it prints what's on screen,
not what's on disk.

While a print is running you get a progress window in the notification area, naming the
step you're waiting on — including the one-off converter build on first use, which is
the longest silent stretch. It stays up until the dialog appears or the printer picker
asks you something.

### Two-sided printing

mdprint asks the queue what it can do — `lpoptions -l` — and offers two-sided rows only
when the printer actually advertises them. If it doesn't, you get told so rather than
being handed a choice that would fail at the printer.

The choice is remembered per printer, so the second print is one click again.

> **Note on `lpoptions` parsing:** CUPS prints keys as `Duplex/Duplex: *None
> DuplexNoTumble DuplexTumble` — name, slash, human label. The name before the first
> slash is the part you can pass as `-o`. Reading the whole key is how a printer that
> genuinely does two-sided gets reported as single-sided-only, which is exactly the bug
> this release fixes.

### Per-item templates

A template can be set three ways, and the **last one that applies wins** — so the
narrowest scope beats the widest:

```
built-in  →  mdprint.themeFile  →  <doc>.mdprint.css  →  mdprint.theme  →  live buffer
  widest  ────────────────────────────────────────────────────────────────▶  narrowest
```

- **`mdprint.themeFile`** — one stylesheet for the whole workspace. Set it once
  and every document inherits it.
- **`<doc>.mdprint.css`** beside the file — this item's own template. Travels with
  the document through git, and **wins over `themeFile`**.
- **`mdprint.theme`** — inline CSS from settings, stacked after the file layers.
- **The live buffer** — *Customise template for this item…* opens an unsaved CSS
  scratchpad for the document in front of you. It sits on top of everything, so
  you can experiment without touching any file. Print uses it as you type; close it
  and it's gone.
- A template **cannot** set paper size. That's stripped and logged; margins are honoured.

Nothing needs rebuilding, repackaging or reinstalling to change how a document
looks — edit a file, or open the live buffer, and print again.

### Settings

A saved setting is a **default, never a lock**. These exist:

- `mdprint.defaultPrinter` — skip the picker when only one answer makes sense.
- `mdprint.printerSettings` — per-printer memory of duplex and copies, written
  automatically when you choose them.
- `mdprint.themeFile` — a workspace-wide stylesheet, or empty for none. An item's own
  `<doc>.mdprint.css` stacks after it and wins.
- `mdprint.theme` — inline CSS for experiments, or empty for none. Sits on top of the
  file layers; the live template buffer still beats it.

They're global, not per-workspace, because a printer is a device attached to the
machine rather than a property of a project.

With nothing saved, mdprint passes **no flags at all** and lets the printer do what
it's configured to do.

---

## Tests

```bash
npm test
```

Runs the build, then 151 tests across thirteen layers:

| Layer | File | What it protects |
|---|---|---|
| Docs vs code | `docs.test.ts` | That the README's precedence order is the one the resolver actually stacks. Docs that lie about precedence cost a consumer their whole template. |
| Golden fixtures | `renderer.test.ts` | 7 markdown files → 7 known-good HTML outputs. One per bug that cost real time. |
| CSS invariants | `css.test.ts` | The print rules that stop silent truncation — wrapping, margins, page size. |
| Template precedence | `theme.test.ts` | That the layers stack in order — built-in → workspace file → `<doc>.mdprint.css` → setting → live buffer — and that the user's template always wins, including over the built-in. Also that a template can never change the **paper size**. |
| Job → argv | `printjob.test.ts` | That an unset duplex produces **no** `sides` flag, so printer defaults survive. |
| Capability parsing | `duplex.test.ts` | That `Duplex/Duplex: *None …` is read as the **Duplex** option, not ignored. Run against real recorded printer output. |
| Capability advertising | `duplexPicker.test.ts` | That a detected capability actually reaches a picker. Detecting is not advertising. |
| Destination rules | `destination.test.ts` | That the list is always shown, that **Save as PDF** is in it on a machine with no printers, and that a printer named "Save as PDF" can never collide with the PDF row. |
| Wiring | `wiring.test.ts` | That choosing the PDF row actually calls the save step. Resolving to `{kind:'pdf'}` and doing nothing is not saving. |
| Progress | `progress.test.ts` | That the bar advances, only forwards, and never reports full while work continues. |
| Platform seam | `detect.test.ts`, `doors.test.ts` | Backend detection picks the right class, and every backend capability is reachable from a registered command. |
| Handoff lifespan | `lifespan.test.ts` | That a PDF handed to another program **outlives this run**. The scratch dir is deleted in a `finally`, so a handed-over path used to vanish — printing silently did nothing and the dialog reported *"there is no such file"*. Now asserts the real filesystem: release, delete the scratch dir, file still there. |
| Build integrity | `shim.test.ts`, `packaging.test.ts`, `workdir.test.ts` | The embedded native source matches its original, test byproducts never ship, and the scratch dir exists before anything writes to it. |

### Two rules these tests exist to enforce

**A test that re-implements the code under test cannot fail for the right reason.**
`duplex.test.ts` originally had a mirror of the parsing loop, and when the original
bug was put back by hand the whole suite stayed green. The parser is now extracted as
`parseCapabilities()` and called directly, and the mutation turns it red.

**A test that filters away the values it's checking proves nothing.** The backwards
guard in the progress bar was invisible to the suite because the helper discarded
non-positive increments — the very values the guard exists to prevent. It's now
asserted against `advance()` directly.

Useful variants:

```bash
npm run lint          # type-check only, no emit
npm run watch         # rebuild on save
npm run test:watch    # rebuild + re-run tests on save
```

### On golden fixtures

Each fixture in `test/fixtures/` is one bug, frozen:

`page-width` (right-edge clipping) · `code-bleed` (long lines) · `details` (collapsed
sections) · `frontmatter` · `mixed-blocks` · `table-wide` · `basic`

When a test fails, the freshly rendered output lands in `.actual/` so you can diff it
against the golden. **A golden is only ever regenerated deliberately, with a reason, and
read by eye first** — blessing whatever the renderer happened to produce is how a
regression gets locked in permanently.

### Keeping the native source in sync

The Swift converter exists as **two deliberate copies**:

- `src/platform/shim.swift` — the editable original
- `src/platform/shim-source.ts` — a generated module that embeds it as a string

This is what actually ships. After editing the `.swift` file:

```bash
npm run embed-shim
```

`shim.test.ts` fails if the two drift apart. To prove the *shipped* copy works (not
just that the source files match), extract it back out of the build — with no argument
it writes to `/tmp/mdprint-shim-check.swift` and prints the exact `swiftc` line to run:

```bash
npm run extract-shim
```

### What is deliberately not tested

Real printing. That needs a printer and burns paper, so it stays a manual checklist:

1. Print an unsaved (dirty) buffer — output matches the screen, not the disk.
2. Ask for duplex on a single-sided printer — it should **refuse explicitly**, never
   silently print one-sided.
3. Print a document longer than one page that ends in a table — the table and the
   footer are both on the last page.
4. Print with a long code line — it wraps; nothing is cut at the right edge.
5. Print to a queue that needs auth — the error names the problem, no silent stall.
6. Cancel the picker — nothing prints, no error.

---

## The shim

One piece of this is not TypeScript.

Everything else ports fine: markdown → HTML is in-process, page styling is CSS, sending
the PDF to a printer is `lp`. The gap is **HTML → PDF**. Node has no good engine for
that short of shipping a Chromium (~150 MB), and macOS already has one — WebKit.

So `src/platform/shim.swift` is a small Swift program that boots `WKWebView`
**offscreen** — no window, no tab, no browser app, nothing visible — loads the styled
HTML, renders it, and writes a PDF. It's an interface binding, not a runtime
dependency: it wraps a framework already on the machine.

Two things it does that are worth knowing:

- **It paginates by hand.** `WKWebView.createPDF` is a single-page renderer — it sets
  the paper size and silently drops everything past page one, with no error and a
  perfectly valid-looking A4 `/MediaBox`. The shim measures the DOM, packs blocks into
  page buckets without slicing a paragraph or table row, and merges the pages with
  **PDFKit**.
- **It reports its geometry on stderr** — `page: A4 margins t14 r15 b16 l15mm` — which
  lands in the mdprint output channel. That's the fastest way to answer "why does this
  sheet look like that" without printing anything.

Because it compiles on first run, you never receive a binary that doesn't match your
machine, and there's nothing to build at package time.

### Adding another OS

One interface (`src/platform/types.ts`), one class per OS. Adding a platform should
touch exactly one new file — if anything outside `src/platform/` needs to change, the
seam is wrong. Linux and Windows are new classes, not rewrites.

---

## Troubleshooting

Open the **mdprint** output channel (*View → Output → mdprint*) first — it carries the
converter build log, the page geometry, and the exact command sent to the printer.

**"mdprint needs Xcode's command line tools…"**
Run `xcode-select --install`, finish it, and retry. Nothing prints until this is done.

**"Couldn't build mdprint's PDF converter…"**
The message includes the exact path of the converter source that failed, which is the
reliable way to find it — the scratch directory differs per machine. It's under the
system temp dir, in `mdprint/shim/`:

```bash
ls "$TMPDIR/mdprint/shim/"     # mdprint-pdf.swift, mdprint-pdf, source.sha256
```

Compile it by hand to see the underlying error in full:

```bash
swiftc -o /tmp/mdprint-pdf "$TMPDIR/mdprint/shim/mdprint-pdf.swift" \
  -framework WebKit -framework AppKit -framework PDFKit
```

The three `-framework` flags are required — dropping `PDFKit` fails with
`no such module 'PDFKit'`. A stale binary is never the problem: the build is keyed on a
source hash, and a failed compile deletes its output rather than leaving a half-written
binary behind.

**A printer is missing from the list**
mdprint reads the OS printer list (`lpstat -l -p`) rather than keeping its own. If a
queue isn't there, the OS doesn't have it. CUPS destinations are also not always visible
to a non-interactive shell — but the extension runs in your desktop session, so what you
see in System Settings is what it sees.

**A print job vanishes with no error, or hangs "waiting for authentication"**
That queue needs a username and password. Add it with credentials in System Settings,
and make sure the queue was created with `auth-info-required=username,password`. mdprint
reports this rather than pretending to work.

**Every page after the first was blank**
That was the old bug — `createPDF` not paginating. It's fixed; if you see it again it's
a regression, and page 2+ of a long document is the test to run.

**Nothing prints and there's no error**
Check the output channel. The pipeline is fail-loud by design — every failure path ends
in one plain-English sentence, so silence means something upstream of mdprint.

---

## Layout of the repo

```
src/
  extension.ts        activation + the five commands
  document.ts         getting the text (dirty buffer or file)
  renderer.ts         markdown -> styled HTML
  css.ts              the print stylesheet
  printer.ts          choosing a printer, never guessing
  options.ts          the "Print with options…" door
  settings.ts         per-printer memory (default, never a lock)
  platform/
    types.ts          the seam: PrintBackend + PrintJob
    detect.ts         runtime OS detection -> the right class
    macos.ts          the macOS backend
    lp.ts             the shared CUPS rail
    pdf.ts            HTML -> PDF, and the one-time shim build
    shim.swift        the native converter (editable original)
    shim-source.ts    the same code, embedded (generated)
scripts/
  embed-shim.mjs      shim.swift -> shim-source.ts
  extract-shim.mjs    shipped build -> .swift, for verification
test/fixtures/        markdown + golden HTML, one pair per paid-for bug
poc-reference/        the Python proof of concept. Reference only, never shipped.
```

See [SPEC.md](SPEC.md) for the decisions and the reasoning behind them.
