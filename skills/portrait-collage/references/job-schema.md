# Job protocol v1

This protocol supports optional `source-face-harmonized` and `source-face-exact` restoration. Default `integrated` work generates and visually reviews a complete collage without this pipeline. The legacy JSON field `background` means the complete generated scene draft WITH the intended people already present, not an empty background plate. Do not paste source people into the target before detecting them or fabricate target detections. Back views do not require face detection or a face job.

Use absolute paths or paths relative to the draft/job file. Commands refuse existing job/report files and nonempty output directories. Resolve the angle-bracket notation below to real paths.

```text
<python> <skill>/scripts/detect_faces.py --input <source.jpg> --out <run>/source-detections.json --expected-faces 2
<python> <skill>/scripts/detect_faces.py --input <scene-draft.png> --out <run>/target-detections.json --expected-faces 2
<node> <skill>/scripts/align_faces.cjs --draft <run>/draft.json --out <run>/job.json
<node> <skill>/scripts/compose.cjs --job <run>/job.json
<node> <skill>/scripts/verify.cjs --job <run>/job.json --report <run>/pixel-check.json
<node> <skill>/scripts/verify.cjs --job <run>/job.json --review <run>/visual-review.json --report <run>/verification.json
```

Set expected-faces from observation. Default max-faces is four. A count mismatch writes a preview for inspection but exits with failure. Do not treat it as success.

For distant faces, use `--roi x,y,width,height` to focus inference on a visually selected group of heads. Coordinates are in the oriented ORIGINAL image; returned landmarks remain in that full-image coordinate system. Include all intended faces and continue to check the original for excluded people. Use a new output filename for a retry. The ROI is detection context, not the protection mask.

Draft example (add a mapping for EVERY detected source face):

```json
{
  "source": "source.jpg",
  "background": "scene-draft.png",
  "sourceDetections": "source-detections.json",
  "targetDetections": "target-detections.json",
  "canvas": { "width": 3000, "height": 5000 },
  "outputDir": "result-v1",
  "design": { "mode": "source-face-harmonized", "density": "rich", "text": "花间" },
  "faces": [{
    "id": "person-left", "sourceId": "face-1", "targetId": "face-1",
    "appearanceMode": "source-face-harmonized",
    "harmonizeStrength": 0.32,
    "identityReview": "Checked source/target crops: same left subject, clothing, hair and pose."
  }]
}
```

IDs come from actual detections; positional indexes do not establish correspondence. `id` uses lowercase letters/digits/hyphens. Optional `outerPolygon` is an array of [x,y] original-image points, and `featherPx` is a positive source-pixel width. Defaults are candidate expanded ovals, subject to visual review. Task coordinates belong in JSON, never scripts.

Newly aligned jobs default to `blendMode: "adaptive-ring"`: opacity transitions across the full space between core and outer polygons, preserving opacity 255 within the entire core. In this mode `featherPx` sets the minimum allowed core-to-outer clearance, not a narrow strip of blending. `blendMode: "edge-feather"` retains the original narrow outer-edge algorithm; old jobs without this field retain that legacy behavior. Unknown modes fail validation. Changes to contours or modes require a new draft/job/output; keep the protected core unchanged.

`appearanceMode` is `source-face-exact` by default for backward compatibility. Set it to `source-face-harmonized` to retain source high-frequency detail while shifting low-frequency color toward the generated target. Its optional `harmonizeStrength` defaults to 0.32 and must be 0..0.6; `harmonizeRadiusPx` defaults from source face width and must be 2..200. Parameters are per face because lighting can differ. Create a new job and output for every parameter change.

Alignment adds source/background hashes, dimensions, computed transforms, and a protection file/hash. `alignmentSha256` covers IDs and transforms. Do not edit locked jobs; create a new draft revision. Protection files are per task, not persistent biometric profiles.

Visual-review format:

```json
{
  "finalSha256": "actual SHA-256 of final.png",
  "jobSha256": "actual SHA-256 of job.json",
  "checks": { "mapping": true, "seams": true, "composition": true, "text": true },
  "notes": "Concrete observations after viewing the final, selections and all face crops."
}
```

The initial report has ready=false until visual review. `source-face-exact` requires zero changed core pixels, matching final provenance and four visual checks. `source-face-harmonized` reports `pixelsPassed: null` and `pixelVerification: not-applicable`; completion requires provenance plus the same visual checks. Pixel equality alone never establishes natural integration or aesthetic quality. The JPEG preview is not the verified master.
