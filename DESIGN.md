# aRa — A feeling, in every frame

The cinematic invitation remains the opening visual thesis: botanical ivory doors reveal a warm wedding venue as the visitor scrolls. The expanded site carries that sense of memory through a dimensional photo carousel, staggered typography, asymmetric detail photographs, a full-bleed celebration scene, the dance floor, service exploration and a real enquiry.

Warm paper #f3f0e8, forest ink #20251f and restrained brass accents continue the established brand world. Self-hosted Cormorant Garamond provides expressive display typography; Manrope provides functional copy. Large photographic apertures and deliberate empty space establish pacing rather than generic cards or invented proof.

## Motion and rendering

GSAP is the sole choreography engine, with one Lenis instance for smooth wheel scrolling and native touch scrolling. Headings reveal word by word with a preserved accessible label; supporting content follows in restrained groups. Detail images, the celebration scene and the night image use bounded parallax. Service images decode before transitioning. Form controls stay interactive throughout their entrance.

The opening now uses a fully buffered, all-keyframe H.264 film in place of hundreds of per-scroll image fetches and a decoded bitmap LRU. This removes decode/request churn while seeking. Desktop1440×810 and mobile960×540 variants preserve all210 source positions at30fps. The WebGL pass holds two textures for a65ms interpolation blend, gentle lens framing and pointer response. Its drawing buffer is capped, and it renders only while a frame or pointer is changing. A native video fallback preserves scroll scrubbing without WebGL. A static poster is complete before the media loads.

The six-image cinematic carousel uses custom WebGL vertex/fragment shaders on a32-segment plane. Perspective, depth, subdued adjacent images and velocity-driven curvature make each transition spatial. Three planes draw at rest, up to four while moving; at most five image textures are retained. Its loop stops when settled, offscreen or hidden. Dragging has button and keyboard alternatives; there is no autoplay. A CSS perspective carousel provides the same controls when WebGL is unavailable.

Reduced motion bypasses the invitation film, WebGL, smooth scrolling and spatial scroll effects. The gallery remains navigable with immediate transitions. Without JavaScript, all six gallery photos become a static collection and phone/WhatsApp links remain usable.

## Photography and content

Eight new licensed event images expand the existing collection: a South Indian couple, a garland ritual, a bridal portrait, henna detail, roses, a vibrant wedding gathering, a buffet and a plated cuisine spread. The henna/buffet composition and full-width celebration scene add distinct editorial layouts. All imagery is disclosed as inspiration or concept imagery, not company portfolio work.

The six services and supplied phone number remain the factual foundation. Service choices preselect an editable WhatsApp draft. No fabricated awards, reviews, addresses, pricing or completed-project claims were added.

## Guidance applied

Designer Skills with UI/UX Pro Max informed drag alternatives, motion sensitivity, readable controls and touch targets. The Awwwards-quality workflow, Taste’s architecture-led direction and frontend design rules informed the visual narrative. Animation and graphics-performance guidance informed easing, bounded GPU work, resource cleanup and fallbacks. Raw WebGL provides the requested texture/depth effects without adding an unused scene framework.
