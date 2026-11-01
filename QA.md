# Verification — WebGL and cinematic collection update

## Passed

- JavaScript syntax checks for app.js, portal-sequence.js, cinematic-carousel.js and gl-core.js.
- Both actual shader pairs compile and link in an offscreen Mesa/EGL OpenGL ES context. The carousel shaders rendered three textured planes successfully; the result was visually reviewed. This caught and fixed a shared-uniform precision mismatch before delivery.
- Actual connected-browser checks at375,390,768 and1440px responsive widths: no horizontal document overflow; all primary headings remain two lines.
- Film scroll seeking and reverse seeking converge to the requested time. A desktop sample averaged about20.7ms per completed seek over25 seeks in this test environment. This is a diagnostic sample, not a real-device or field-performance promise.
- Pause at2.271seconds remained2.271seconds while scrolling backwards. Resume converged to1.300seconds for target1.304seconds, within a30fps source frame.
- Carousel next button changes slide0→1; ArrowRight changes1→2 immediately; dragging changes2→3. Mobile next button also updates the title and selected slide. Buttons, dots and keyboard alternatives are present; no autoplay.
- Catering selection decodes and displays the new cuisine photo. Its enquiry CTA preselects Catering in the form. Empty required name blocks submission; status remains empty and no WhatsApp message is sent.
- Mobile menu opens, navigates to The gallery and closes after selection.
- Reduced-motion mode loads no film, uses the static invitation and a CSS carousel, and keeps the hero at one viewport. No-JavaScript mode shows all six static gallery photos, hides the loading message, disables submit and retains contact fallbacks.
- Expanded detail composition and full-bleed celebration design visually reviewed. The16 new responsive image files decoded successfully during processing. Provenance is stored with the assets and in ASSET_CREDITS.md.
- Only unrelated browser-extension metadata errors appeared in the console; no application errors were observed.
- Local asset references, anchors, unique IDs, media metadata and hosting configuration checked before packaging. Temporary QA harness excluded from delivery.

## Verification limits

The connected browser disables WebGL, so browser visual checks exercised the native-video and CSS perspective fallbacks. The actual GLSL programs were separately compiled, linked and rendered through offscreen OpenGL ES; real-browser GPU performance, touch inertia and context recovery still require device testing. Drawing buffers, textures and offscreen work are capped to reduce GPU cost.

The opening film is fully buffered before interactive seeking. Visitors see a complete static invitation and a loading status while it downloads. Connection speed still affects readiness. Its source is AI concept imagery; encoding does not create additional original detail. All stock photography is labelled as visual inspiration, not aRa portfolio work.

The website remains owner-private. No audience expansion, lead database, automatic message sending, analytics or payments were added.
