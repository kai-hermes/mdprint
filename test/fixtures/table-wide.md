---
title: Wide Table
---

A table with more columns than comfortably fit should still be constrained to
the content column rather than running past the right paper edge.

| Duplex | PaperSize | InputSlot | MediaType | PrintQuality | Copies | Collate | FitToPage | OutputBin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DuplexNoTumble | A4 | Auto | Plain | Normal | 1 | True | False | Auto |
| DuplexTumble | A4 | Tray1 | Plain | High | 2 | False | True | Auto |
| None | A5 | ManualFeed | Photo | Normal | 1 | True | False | Auto |

And a ragged row, which must not shift the columns:

| One | Two | Three |
| --- | --- | --- |
| only two |
