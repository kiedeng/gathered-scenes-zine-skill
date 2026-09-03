# Fork modifications

This repository is a modified copy of [Zeejay0/gathered-scenes-zine-skill](https://github.com/Zeejay0/gathered-scenes-zine-skill). The original author, source notices, and Personal Non-Commercial License remain unchanged.

## Added by this fork

### `skills/portrait-collage` 1.2.0

This fork adds a separate portrait-oriented skill. It follows the source project's paper-collage direction while addressing identity-sensitive photographs through a local face workflow.

- Generates a complete collage with people present rather than an empty background for later whole-person pasting.
- Provides `integrated`, `source-face-harmonized`, and `source-face-exact` modes.
- Uses MediaPipe only for local landmark location; it does not perform identity recognition.
- Uses similarity alignment without stretching facial geometry.
- Uses Sharp for local compositing and low-frequency light/color coordination.
- Keeps strict zero-difference pixel checks separate from harmonized processing claims.
- Includes regression tests for one- and two-face composition, transition blending, corruption detection, and harmonized-report semantics.

The added skill is a fork-specific modification and is not represented as an official upstream release. It is distributed under the repository's existing personal, non-commercial license.

Modification date: 2026-09-04.
