# aRa Events & Studio

Cinematic event-studio landing page with scroll-driven film, a Three.js opening arch, floating photographs, liquid-glass controls, and an interactive gallery.

## Run locally

Requires Node.js 20 or newer and Python 3.

```sh
npm ci
npm run build
python3 -m http.server 4173 --directory dist
```

Open http://localhost:4173 in a browser. The ready-to-serve static website is in `dist/`.

## Deploy

Build command: `npm run build`

Publish directory: `dist`

All production imagery, video, fonts, and JavaScript are included. Enquiries open an editable WhatsApp draft; the site does not send messages automatically.

## Source and design

- `src/`: Motion controls and the procedural Three.js scene/model.
- `dist/`: static page, styles, scroll film, gallery, and production assets.
- `scripts/build-premium.mjs`: bundles the runtime and copies license notices.
- `SURFACE-V4.md`: current design and motion contract.
- `QA-V4.md`: verification and known limits.
- `.img2threejs/portal-v4/`: 3D reconstruction source and review evidence.

Photography is illustrative; see the credits and provenance included with the site. The arch is a stylized generated concept, not a surveyed model of a venue.

Exported from Site source commit `45913a437c52c851594730db525235df23cdc07a`.
