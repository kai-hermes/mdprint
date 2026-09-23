---
title: GFM Showcase — Design Proof
---

This is the preamble — a standfirst paragraph that sits above the first rule and
should read distinctly from the rest of the body. It exists to check that the
`.preamble` treatment still earns its keep once everything else around it has
had a design pass.

## Headings

# This is an H1 inside the body (rare, but happens)
## A second-level heading
### A third-level heading
#### A fourth-level heading

Body copy under a heading, to check the rhythm between a heading and the
paragraph that follows it. **Bold**, *italic*, ***bold italic***, ~~strikethrough~~,
`inline code`, and ==highlighted text== should all sit comfortably in a single
line without fighting the leading.

## Emphasis and links

A paragraph with a [normal link](https://example.com/some/path) and a bare
autolink <https://example.com/bare> sitting side by side, plus a link whose
text is itself code: [`inline-code-link`](https://example.com/code).

## Lists

Unordered:

- First item
- Second item with a nested list
  - Nested one
  - Nested two
    - Nested three, three levels deep
- Third item

Ordered:

1. Step one
2. Step two
3. Step three
   1. Sub-step A
   2. Sub-step B

Task list:

- [x] Ship the release
- [x] Fix the handoff bug
- [ ] Redesign the template
- [ ] Ship the redesign

## Blockquotes

> A single-line blockquote.

> A multi-line blockquote that runs across
> several source lines and should collapse
> into one visually distinct block, not three.

## Code

Inline `code()` in a sentence, and a fenced block below:

```ts
export function release(pdfPath: string): Promise<string> {
  // a comment explaining why this exists
  return copyToHandoff(pdfPath);
}
```

A fenced block with no language:

```
plain text in a fence
no syntax highlighting expected
```

A fenced block with a long unbroken line, to prove it wraps instead of
bleeding off the paper edge:

```
thisisaveryveryveryverylongunbrokenstringwithnowhitespaceatallthatmustwraprather-than-overflow-the-printed-page-edge-or-get-clipped-silently
```

## Tables

| Feature | Status | Notes |
|---|---|---|
| Dialog handoff | Fixed | PDF now survives the run |
| Duplex printing | Shipped | Advertised per-queue |
| Template redesign | In progress | This document is the test bed |
| Very long cell content | Testing | This cell has enough text in it to wrap across more than one line inside its column, to prove the table holds up under real content rather than three-word placeholders |

A second, shorter table:

| A | B |
|---|---|
| 1 | 2 |
| 3 | 4 |

## Horizontal rule

Above the rule.

---

Below the rule.

## Images

![A placeholder image](https://placehold.co/600x200)

## Nested structure

> A blockquote containing a list:
> - item one
> - item two

- A list item containing a code span: `like_this()`
- A list item containing **bold** and *italic*

## Escapes

\*not italic\*, \_not italic either\_, a literal backslash before a character: \\, and a literal asterisk: \*.

## Long-form content for pagination

Paragraph one of a longer run, to give the paginator enough vertical rhythm to
work with across a page boundary. The point of this section is not what it
says but how much room it takes up, so the words themselves are filler dressed
as sentences that scan naturally enough not to distract from the layout.

Paragraph two, same purpose. Long-form technical writing tends to run in
paragraphs of four to six lines at this measure, so this block is sized to
match that shape rather than being either a one-liner or an unbroken wall.

Paragraph three, closing out this section and leading into the final heading
below, which should land cleanly without an orphaned line at the foot of a
page or a heading stranded by itself at the top of the next one.

## Closing

That's the whole surface: headings, emphasis, links, lists (ordered, unordered,
nested, task), blockquotes, inline and fenced code, tables (short and wide),
a horizontal rule, an image, and escapes — the working set of GitHub Flavored
Markdown a real document actually uses.
