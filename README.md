# mdprint

Right-click a markdown file, get a properly typeset page. VS Code / Cursor extension.

**Status: spec only — no code yet.** See [SPEC.md](SPEC.md).

The value here is print layout, not markdown rendering. It is not an editor, not a
preview, and not another markdown renderer.

```
.md  ->  styled HTML  ->  PDF (offscreen web engine)  ->  printer
```

No browser opens. No dialog unless you ask for one. Works on unsaved files.

- **Alpha:** macOS
- **Language:** TypeScript
- **Architecture:** one interface, one class per OS, runtime detection
- **Not:** a print driver. Duplex is a flag; stapling is the OS's job.
