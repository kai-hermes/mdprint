---
title: Right Edge Clip
---

This fixture exists because content overran the RIGHT paper edge and got sliced
off at the paper boundary. The cause was laying out at the full page width
(595.3pt of content on a 595.3pt page) with no margin box reserved, so anything
wider than the page simply ran off it.

## A long unbroken line

AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDDEEEEEEEEFFFFFFFFGGGGGGGGHHHHHHHHIIIIIIIIJJJJJJJJKKKKKKKKLLLLLLLLMMMMMMMN

A very long URL that cannot wrap at a space: https://example.com/a/very/long/path/that/keeps/going/and/going/and/going/without/any/break/at/all/whatsoever/ok

The fix is to inset the content box to the @page margins and rasterise the FULL
page — never to shrink the page rect, which was the first attempt and produced
179.9mm paper instead of A4.
