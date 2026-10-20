# MaxUpload

[![Tests](https://github.com/M15UK/maxupload/actions/workflows/test.yml/badge.svg)](https://github.com/M15UK/maxupload/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Live site: https://m15uk.github.io/maxupload/**

A browser-based video converter that prepares max-quality, high frame rate uploads for TikTok and
compresses videos for any other website. Everything runs on the user's device with WebCodecs; videos
are never uploaded to a server.

Available in English and Saudi Arabic (right-to-left).

## Features

- **TikTok mode:** HEVC 1080p at 7.5 Mbps with the CompressBase upload patch. In tests on real posts,
  TikTok served this file as "original" quality instead of re-encoding it (see [Results](#results)).
  - Resolution: 1080p, or original up to 8K
  - Frame rate: 60 FPS, 120 FPS (experimental) or no limit
  - Enhancer: off, natural or strong (GPU sharpening and color, see below)
- **Compress mode:** smaller H.264 MP4 for any website.
  - Size: up to 10 MB, 25 MB, 50 MB, or best quality with no limit
  - Resolution: original up to 8K, 1080p or 720p
  - Frame rate: no limit, 60 or 30 FPS
- **Two languages:** English and Saudi Arabic with full right-to-left layout, remembered per browser.
- **No server:** a static site. Decoding, resizing, enhancing and encoding all happen in the browser.

## Results

Same 17-second, 60 FPS clip, uploaded to TikTok and measured from TikTok's own player data:

| Upload | What TikTok served |
| --- | --- |
| H.264, 25 to 50 Mbps (plain or timescale-patched) | 576×1024, H.264, ~0.6 Mbps, 30 FPS |
| HEVC 1080p 7.5 Mbps, no patch | 576×1024, H.264, 0.62 Mbps, 30 FPS |
| **HEVC 1080p 7.5 Mbps + CompressBase patch** | **1080×1920, HEVC, 7.75 Mbps, 60 FPS ("original")** |

The winning combination is the default TikTok mode.

## How it works

```
video file > decode (WebCodecs) > resize > enhancer (WebGL2, optional) > encode HEVC / H.264 > MP4
                                                         TikTok mode: CompressBase metadata patch
```

- **Encode planning** (`src/encode-plan.js`): pure functions that choose resolution, constant frame
  rate, bitrate and audio handling for each mode and size limit. Fully unit tested.
- **Conversion** (`src/converter.js`): [Mediabunny](https://mediabunny.dev) on top of WebCodecs,
  hardware-accelerated where the browser supports it.
- **Enhancer** (`src/enhancer.js`): a WebGL2 shader per frame with contrast-adaptive sharpening,
  a gentle S-curve and vibrance that protects skin tones. On 4K output the sharpening radius widens
  so it survives TikTok's downscale to 1080p.
- **Upload patch** (`src/compressbase-method.js`): a client for the free
  [CompressBase Method API](https://compressbase.com/method-api), written from its published protocol.
  Only the MP4 metadata (moov box and box layout) is sent; video and audio stay on the device, and
  metadata tags such as GPS location are removed first.
- **Translations** (`src/i18n.js`, `src/messages/`): message catalogs with placeholders wrapped in
  Unicode direction isolates, so numbers like "1080×1920" and "25 MB" read correctly inside Arabic text.
- **Security:** strict Content Security Policy, and the CDN library is pinned with Subresource Integrity.

## Tech stack

Vanilla JavaScript (ES modules, no build step) · WebCodecs · WebGL2 · Mediabunny ·
Node.js test runner · GitHub Actions · GitHub Pages

## Run locally

Requires Node.js 20 or newer. No install step is needed.

```bash
npm start   # http://localhost:5173
npm test    # 56 unit tests with coverage
```

Works best in a recent Chrome or Edge on a computer (WebCodecs HEVC and H.264 encoding).

## Project structure

```
index.html                  page markup
styles.css                  styles, including right-to-left rules
src/app.js                  UI controller: steps, settings, progress, result
src/encode-plan.js          encoding decisions for both modes (pure, tested)
src/converter.js            Mediabunny / WebCodecs conversion
src/enhancer.js             WebGL2 sharpening and color shader
src/compressbase-method.js  CompressBase Method API client (tested)
src/i18n.js                 translation lookup and bidi helpers
src/messages/               English and Saudi Arabic text
tests/                      node:test unit tests
server.mjs                  small local static server
```

## Limits

- TikTok shows 1080p at most, so larger files are reduced by TikTok.
- 120 FPS on TikTok is not verified yet.
- The output is held in browser memory, so files are kept under 1 GB.

## Credits

- [Mediabunny](https://mediabunny.dev) (MPL-2.0) for reading and writing media files.
- [CompressBase](https://compressbase.com) for the Method API, used with the owner's permission.
- Not affiliated with TikTok.

## License

[MIT](LICENSE)
