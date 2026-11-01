# Stylized aRa portal prop — v4

Final module: `../../src/portal-model.js` (from this evidence directory, actual source is the Site's `src/portal-model.js`). API: `createPortalModel(THREE, options?)` returns `{group, leftDoor, rightDoor, dispose, ready}`. Await `ready` before compiling/fading in. `textureAnisotropy` defaults to 2. Both hinge-local groups start at zero rotation; drive left y from0 to−π/3 and right y from0 to+π/3. The parent scene owns its lighting, photographic planes, glass ring, scroll and rendering loop.

## Provenance and declared scope

The supplied film poster (`dist/assets/portal/poster.webp`) is documentary evidence of the user's supplied AI sequence, not evidence of an actual aRa venue. Its background prevented initial isolated-object admission; those failed reports remain under historical filenames. A genuine transparent isolated concept was subsequently generated with imagegen using the poster as style/proportion reference. Its complete local source is `dist/assets/atmosphere/portal-reference-v4.png`, with generation provenance in `generation-provenance.json`. Generated reference admission passed. Neither the concept nor this prop represents actual company portfolio work.

The procedural asset deliberately approximates an ivory botanical double-door arch, slim champagne brass trim and oval stone base. Hidden rear/depth are inferred. The original fine branching is simplified to two curved stems and fourteen pointed beveled leaves. This is a stylized real-time web prop, not physical venue or photogrammetric reconstruction.

## Review evidence

The distinct `state.json` records all eight sequential passes complete, with five correction iterations. No quality thresholds were lowered. `object-sculpt-spec.json` contains individual review history and Tier1 records. Final `part-coverage.json`:23 specified non-root parts,24 built including plinth,0 errors and0 warnings. `action-ready.json` records zero rest rotations, stable hinges, attached moving relief and24 named nodes/colliders. Generic plugin runner returned no contributing plugin gates; `plugin-gates.json` describes this accurately.

Final mapped closed view: `optimization-pass-front.png`.
Final three-quarter: `optimization-pass-three-quarter.png`.
Final four-view turntable: `optimization-pass-{front,right,rear,left}.png`.
Final reference/render pair: `optimization-pass-comparison.png`.
Production mapped open60° view: `optimization-open60-front.png` and `optimization-open60-three-quarter.png`.
Neutral/grazing detail evidence: `material-pass-neutral-closeup.png` and `material-pass-grazing-closeup.png` (admitted1024 map preview before production downsample).

Captures are offscreen EGL/GLES previews of the actual generated Three.js geometry and actual source-derived texture channels, using a simple GGX material preview. The lighting pass evaluates concept key/fill/rim directions and intensities with ACES-like mapping. These are asset previews, not evidence of browser/Three.js PBR pixel parity. Browser WebGL was unavailable in the shared review environment. No browser FPS or device GPU-memory measurement is claimed.

Historical blockout captures were reconstructed identically after a temporary filename was reused. `blockout-restoration.json` confirms the original Tier1 render hash matches the restored PNG exactly. Later passes keep separate filenames.

## Materials and production budget

Verified crop extraction reports are preserved for ivory, brass and stone. The clean ivory extraction passed0.716 confidence. Single-image roughness/normal/height/AO inference remains approximate and warnings remain in source reports. The actual botanical identity uses geometry. A rejected ivory crop that included a visible relief fragment was replaced before material acceptance.

All15 admitted1024 maps remain in `dist/assets/atmosphere/materials/`. Production derivatives are under `dist/assets/atmosphere/materials/production/`:512px albedo/roughness/normal/AO,256px redundant height maps. Fifteen files total1,590,865 bytes. Estimated RGBA8 storage including complete mip chains is17,825,792 bytes (17MiB); actual driver allocation can differ. All filenames use `{ivory,brass,stone}_{albedo,roughness,height,normal,ao}.png`. All runtime URLs begin `/assets/atmosphere/materials/production/`. No executor or evidence-directory URL is shipped.

The asset has24 meshes/geometries,4,136 triangles,3 shared materials and15 unique pooled textures. `final-runtime-check.json` verifies async readiness, all URLs exist, rest rotations, bounds3.7×4.38×1.8 and exactly-once disposal. Parent normalizes overall height to4 world units. No particles or shadow maps are created.

The adapter preserves the generator's named `sculptRuntime` hierarchy and returns its `leftDoor`/`rightDoor` nodes. Two documented generator corrections preserve curved sweep geometry rather than endpoint cylinders, and add actual bevels to six-point leaf profiles. The repetition system refers to already authored components, preventing duplicate box geometry. The thin wrapper adds a per-instance texture pool, loading promise and idempotent cleanup; it does not add scene lighting or animation loops.
