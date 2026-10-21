# Your reference sketches

Drop labelled SVG diagrams here and the tutor uses them for structures that have no
built-in template, before searching online or sketching with AI.

- **File name = subject**: `ear.svg`, `kidney_nephron.svg`. Filler words ("human",
  "structure", "diagram", "anatomy") and word order are ignored when matching.
- **Labels must be real text** (`<text>`), each joined to its part by a leader line.
  The end with a marker (dot/arrow) — or otherwise the end away from the text — is
  where the callout will point. Labels written directly on a shape also work.
  SVGs whose text was converted to outlines can't be used.
- **Optional sidecar** `ear.json`:

  ```json
  { "title": "Human ear", "aliases": ["ear_anatomy", "inner_ear"],
    "author": "Lars Chittka; Axel Brockmann", "license": "CC BY 2.5",
    "source": "https://commons.wikimedia.org/wiki/File:Anatomy_of_the_Human_Ear.svg" }
  ```

  `author` and `license` are drawn as a credit line under the sketch — required for
  CC BY / CC BY-SA material.

Sketches from this folder count as approved: every lesson can use them.
