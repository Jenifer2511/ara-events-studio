# Glass invitation — delivery verification

## Verified implementation

- Production build succeeds with pinned Three.js0.187, Motion14.9 and esbuild0.28.2. One Lenis instance; GSAP owns scroll, Motion owns control springs, Three owns the sculptural scene. No framework migration or second scroll engine.
- JavaScript syntax checks pass. The existing film/gallery GLSL pairs compile/link and render in offscreen GLES. The rounded gallery shader retains correct image coverage.
- Image2threejs reconstruction completed eight ordered passes. The final prop has4,136 triangles,24 meshes/geometries,3 shared materials and15 pooled production textures. Parent integration confirms height normalisation to4, finite positions, zero-rest hinges, the0–60° opening range, readiness and idempotent teardown.
- Asset visual evidence uses actual geometry and source-derived maps in offscreen EGL/GLES GGX previews. The model is deliberately stylized, including inferred hidden geometry. Source-PBR evidence is inference, not physical measurement; browser/Three PBR pixel parity is unverified.
- The production model maps transfer1,590,865 bytes with an estimated17MiB RGBA8+mip footprint. Rendering is lazy, capped at1–1.25DPR and1900×1300 pixels, paused outside the viewport/hidden tabs, and stopped by Pause3D. No shadow maps, postprocessing chain or particle system.

## Browser checks

- Reviewed the opening, atmosphere, gallery and enquiry. At375/390/768/1440 widths, no horizontal document overflow; h1 is one line and main h2 headings remain two lines.
- Fixed the floating photograph’s collision with the desktop headline and adjusted tablet spacing. The fixed glass navigation remains readable; anchor offsets keep headings clear.
- Wedding,Afterdark andPortraiture controls update the active spring lens, copy, photographs, URL mood and corresponding service. Keyboard selection updates immediately. Portrait enquiry preselects Photography&films.
- Empty name blocks OpenWhatsAppdraft. No message was sent. Native phone/Instagram/WhatsApp destinations remain unchanged.
- Keyboard Pause3D changes the control to Resume3D and sets the scene paused. The fallback photo motion uses the same state.
- Reduced motion loads no invitation film, hides the Three canvas, removes float animation and keeps controls/content. Reduced transparency removes backdrop filters and uses opaque readable surfaces.
- No-JavaScript mode hides inactive mood/menu/preference controls, shows all six gallery photos, disables the scripted form submit and retains contact links.
- The connected browser disables WebGL. Browser visual checks cover video/CSS fallbacks; actual graphics geometry/maps and shaders were checked separately. Real-device GPU speed is not measured.

## Design review and intentional exceptions

Taste source lint:0FAIL,3glassWARN. The warnings are the user-pinned LiquidGlass/Glassmorphism material, confined to navigation, controls and the enquiry panel. Numbering is the meaningful current-photo position, not a decorative section index. Gradients are neutral photographic readability scrims.

Impeccable’s one requested mechanical scan was reviewed against the actual render. Generic full-bleed/padding findings do not reflect the inset absolute captions and controls; the white-on-cream warning does not model the photograph’s dark scrim. The genuinely undersized footer brand descriptor was raised to13px. Ivory is inherited from the supplied invitation. Credit separators were simplified. Existing product-record metadata remains legacy; the functional truth was preserved, and v4 decisions are documented in SURFACE-V4.md rather than rewriting the incumbent record.

Vercel Web Interface Guidelines were fetched fresh and applied to controls, focus, form labels, image dimensions, animation, pointer alternatives and fallbacks. Header/form contrast tokens and photo-scrim bounds were checked; this is not a whole-site certification.

The original supplied film/archive remains unchanged. Generated arch provenance and reconstruction evidence are in .img2threejs/portal-v4; licensed photo credits remain visible on the page. No awards, customers, reviews, location or commercial proof were invented. Existing owner-private access is preserved.
