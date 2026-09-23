// mdprint — the print stylesheet.
//
// A redesign (2026-09-22) over the POC original: same load-bearing print
// rules (every one of them earned on real paper, see the comments inline),
// but with a proper type scale, an accent colour used with intent, cleaner
// tables, and a rewritten @page block (see the note above it for why the
// old :left/:right/:first split had to go — the Swift shim cannot honour
// per-side page selectors and was silently blending them into one).
//
// Treat the @media print rules and the @page block as DATA, not code you can
// tidy: the tests in test/css.test.ts assert the load-bearing rules are still
// present, because the single most likely refactor accident is someone
// deleting a fix that looks redundant.

export const PRINT_CSS: string = `
/* mdprint.css — print stylesheet
   Standalone: works as a linked file OR inlined into the HTML. No deps. */

/* ============================================================
   1. TOKENS — a small, print-safe palette. Dark-mode readers still
   print light: every token here is redeclared, pinned, inside
   @media print below, so a system dark theme can never leak onto
   paper.
   ============================================================ */
:root{
  --ink:#1a1d23;
  --ink-soft:#4b5563;
  --ink-faint:#8790a0;
  --rule:#d6dbe3;
  --rule-soft:#e9ecf1;
  --panel:#f6f7fa;
  --accent:#2454b8;
  --accent-soft:#eaf0fd;
  --warn:#8a5a00;
  --warn-soft:#fff6e0;
  --font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --measure:17px;
  --leading:1.65;
}

/* ============================================================
   2. @page — one rule, one truth.
   The Swift shim reads every @page block it finds and lets a later
   declaration win over an earlier one, exactly like the cascade — so
   a \`@page :left\`/\`:right\`/\`:first\` split here would silently blend
   into ONE set of margins rather than the per-side ones their
   selectors promise (the shim has no concept of facing pages). A
   single block is not a simplification for its own sake: it is the
   only form that says what actually happens.
   ============================================================ */
@page{
  size:A4;
  /* top right bottom left */
  margin:18mm 20mm 20mm 20mm;
}

html{
  -webkit-text-size-adjust:100%;
}

body{
  margin:0;
  padding:0;
  background:#fff;
  color:var(--ink);
  font-family:var(--font-body);
  font-size:var(--measure);
  line-height:var(--leading);
  /* Screen only: keep text off the window edges. Print uses @page margins. */
  max-width:44rem;
  margin-inline:auto;
  padding:32px 24px 64px;
}

/* ============================================================
   3. PRINT — the rules that cost real bugs to learn
   ============================================================ */
@media print{
  /* (a) Grid and horizontal flex do not fragment across printed pages —
         content past page 1 silently vanishes. Force block layout. */
  body{display:block;max-width:none;padding:0;font-size:9.5pt;line-height:1.45;}
  main,article,section,div,header,footer{
    display:block !important;
    grid-template-columns:none !important;
    float:none !important;
  }

  /* (b) Pin EVERY token to its light value. A reader in dark mode must
         still get a light, ink-frugal page. */
  :root{
    --ink:#000;
    --ink-soft:#2c2c2c;
    --ink-faint:#63666c;
    --rule:#c3c8d0;
    --rule-soft:#e0e3e8;
    --panel:#f5f6f8;
    --accent:#1c4587;
    --accent-soft:#eef3fc;
    --warn:#6b4600;
    --warn-soft:#fdf7e8;
  }

  /* (c) Colours and backgrounds must survive the print dialog */
  html,body{background:#fff !important;}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact;}

  /* (d) Show things that are collapsed on screen */
  [hidden]{display:revert !important;}
  details{display:block !important;}
  details > *{display:block !important;}

  /* (e) Never strand a heading at the foot of a page */
  h1,h2,h3,h4,h5,h6{
    break-after:avoid;page-break-after:avoid;
    break-inside:avoid;page-break-inside:avoid;
  }
  h2{
    break-before:auto;
    margin-top:1.3em;
  }

  /* (f) Keep blocks whole — the bug that split code mid-page */
  pre,blockquote,table,figure{
    break-inside:avoid;page-break-inside:avoid;
  }
  pre{
    /* Long lines wrap instead of bleeding off the paper edge */
    white-space:pre-wrap;
    overflow-wrap:anywhere;
    word-break:break-word;
  }

  /* (g) Widows/orphans — no single dangling lines */
  p,li{orphans:3;widows:3;}

  /* (h) Links: show the target, since paper can't be clicked */
  a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--rule-soft);}
  a[href^="http"]::after{
    content:" (" attr(href) ")";
    font-size:.78em;
    color:var(--ink-faint);
    word-break:break-all;
  }
  /* ...except when the link text already IS the URL */
  a[href^="http"]:has(> code)::after,
  a[href^="http"].bare::after{content:"";}

  /* (i) Drop screen-only chrome */
  .no-print,nav,.toc-toggle{display:none !important;}

  /* (j) The running footer — version tracking on every page. The Swift
         shim repositions this per page while rendering (position:fixed
         does not survive a multi-shot capture), so this rule is what
         governs it on SCREEN — the live template-customise preview —
         and is the fallback if the PDF is ever produced by something
         other than the shim. */
  .page-footer{display:block !important;}
}

/* ============================================================
   4. TYPE — a clear hierarchy, print-first
   ============================================================ */
h1,h2,h3,h4{line-height:1.25;font-weight:700;font-family:var(--font-body);}
h1{
  font-size:1.55em;
  margin:0 0 .4em;
  letter-spacing:-.015em;
  color:var(--ink);
}
h2{
  font-size:1.15em;
  margin:1.9em 0 .6em;
  padding-bottom:.28em;
  border-bottom:2px solid var(--accent);
  letter-spacing:-.005em;
}
h3{
  font-size:1em;
  margin:1.5em 0 .5em;
  color:var(--ink);
}
h3::before{
  content:"";
  display:inline-block;
  width:.5em;
  height:.5em;
  margin-right:.5em;
  background:var(--accent);
  border-radius:1px;
  vertical-align:middle;
  transform:translateY(-.1em);
}
h4{
  font-size:.85em;
  margin:1.3em 0 .4em;
  color:var(--ink-soft);
  text-transform:uppercase;
  letter-spacing:.04em;
}
p{margin:0 0 .85em;}
strong{font-weight:700;}
mark{
  background:#fdea8f;
  color:var(--ink);
  padding:.05em .15em;
  border-radius:2px;
}
del{color:var(--ink-faint);}

/* Preamble: what you see above the first rule */
.preamble{
  color:var(--ink-soft);
  font-size:.95em;
  border-left:3px solid var(--accent);
  padding:.15em 0 .15em 1em;
  margin:0 0 1.8em;
}

/* Tables — must stay put and read straight down the page */
table{
  width:100%;
  border-collapse:collapse;
  margin:1em 0 1.4em;
  font-size:.92em;
}
thead{
  /* Repeats on every page if the table splits */
  display:table-header-group;
}
tfoot{display:table-footer-group;}
th{
  text-align:left;
  font-weight:700;
  font-size:.82em;
  text-transform:uppercase;
  letter-spacing:.03em;
  color:var(--ink-soft);
  background:var(--panel);
  border-bottom:1.5px solid var(--rule);
  padding:7px 10px;
}
td{
  border-bottom:1px solid var(--rule-soft);
  padding:8px 10px;
  vertical-align:top;
}
tbody tr:nth-child(even) td{background:var(--panel);}
tr{break-inside:avoid;page-break-inside:avoid;}
td code{font-size:.9em;}

/* Callouts */
.callout{
  background:var(--accent-soft);
  border-left:3px solid var(--accent);
  padding:.7em .9em;
  margin:1em 0 1.2em;
  border-radius:0 4px 4px 0;
  break-inside:avoid;
}
.callout.warn{background:var(--warn-soft);border-left-color:var(--warn);color:var(--warn);}
.callout *:last-child{margin-bottom:0;}

/* Blockquote */
blockquote{
  margin:1em 0 1.2em;
  padding:.2em 0 .2em 1.1em;
  border-left:2px solid var(--rule);
  color:var(--ink-soft);
  font-style:italic;
}

/* Code */
code{
  font-family:var(--font-mono);
  font-size:.87em;
  background:var(--panel);
  padding:.12em .35em;
  border-radius:3px;
}
pre{
  font-family:var(--font-mono);
  font-size:.83em;
  line-height:1.55;
  background:var(--panel);
  border:1px solid var(--rule-soft);
  border-left:3px solid var(--accent);
  border-radius:0 4px 4px 0;
  padding:.85em 1em;
  margin:1.1em 0 1.3em;
}
/* Screen: long lines scroll inside the box */
pre{overflow-x:auto;overflow-y:hidden;}
@media print{
  /* Paper: no scrollbar exists, so the box has to wrap instead of clip.
     overflow:hidden also stops the scrollable box from being sliced at
     the page break. */
  pre{overflow:visible !important;}
  pre code{white-space:pre-wrap !important;overflow-wrap:anywhere !important;word-break:break-word !important;}
}
pre code{background:none;padding:0;font-size:1em;}

/* Filename label — must never strand above a code block on the next page */
.filename{
  font-family:var(--font-mono);
  font-size:.8em;
  color:var(--ink-faint);
  margin:1em 0 -.4em;
  break-after:avoid;page-break-after:avoid;
}

/* Lists */
ul,ol{margin:0 0 .9em;padding-left:1.4em;}
li{margin:.3em 0;}
li > ul,li > ol{margin:.3em 0;}
ul > li{padding-left:.15em;}
ul > li::marker{color:var(--accent);}
ol > li::marker{color:var(--ink-soft);font-weight:600;}
/* Task lists (checkbox syntax) */
li.task{list-style:none;margin-left:-1.2em;}
li.task::before{
  content:"";
  display:inline-block;
  width:.85em;
  height:.85em;
  margin-right:.5em;
  border:1.5px solid var(--ink-faint);
  border-radius:2px;
  vertical-align:middle;
  transform:translateY(-.1em);
}
li.task.done::before{
  content:"\\2713";
  background:var(--accent);
  border-color:var(--accent);
  color:#fff;
  font-size:.72em;
  text-align:center;
  line-height:.85em;
}
li.task.done{color:var(--ink-faint);text-decoration:line-through;}

hr{border:0;border-top:1px solid var(--rule);margin:2.2em 0;}

img{max-width:100%;height:auto;break-inside:avoid;border-radius:3px;}

/* Section rhythm marker for print */
.section-rule{display:none;}

/* ============================================================
   5. Page footer — title + date on every page
   Browsers can't repeat arbitrary HTML per page, so the footer
   is a fixed-position element that the print engine repeats on
   SCREEN. The Swift shim gives it an explicit position per page
   when it renders the PDF (position:fixed does not survive a
   multi-shot capture); see shim.swift's positionFooterJs.
   ============================================================ */
.page-footer{
  display:none; /* screen: hidden */
  position:fixed;
  bottom:0;
  left:0;
  right:0;
  font-size:8pt;
  color:var(--ink-faint);
  border-top:1px solid var(--rule-soft);
  padding-top:4px;
  /* Leave room above the paper edge */
  margin-bottom:-8mm;
}
.page-footer .pf-right{float:right;}
.page-footer .pf-page{
  /* Centred independent of the floated title/date either side of it — the
     footer is given position:absolute at capture time (see shim.swift's
     positionFooterJs), which is what makes it this span's containing block. */
  position:absolute;
  left:0;
  right:0;
  text-align:center;
}
`;
