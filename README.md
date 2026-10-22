# MaxUpload

[![Tests](https://github.com/M15UK/maxupload/actions/workflows/test.yml/badge.svg)](https://github.com/M15UK/maxupload/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Live site: https://m15uk.github.io/maxupload/**

A free website that gets your videos ready for TikTok in the best quality, up to 4K and 120 FPS.
It can also make videos smaller for any other website. Everything happens on your own device, so
your videos are never uploaded anywhere.

## What it does

* **TikTok mode:** converts your video so TikTok keeps it in original quality instead of lowering it.
  * Resolution: 1080p, or your original up to 8K
  * Frame rate: 60 FPS, 120 FPS (experimental) or no limit
  * Enhancer + HDR: off, natural or strong, for sharper detail, brighter shadows and richer color
  * Patch: Variant 1 (best for 1080p), Variant 2 (a 1080p backup) or Variant 3 (best for 4K)
* **Compress mode:** makes a video smaller for any website.
  * Size: up to 10 MB, 25 MB, 50 MB, or best quality with no limit
  * Resolution: original up to 8K, 1080p or 720p
  * Frame rate: no limit, 60 or 30 FPS

## Results

Real uploads, checked with TikTok's own player data:

| What I uploaded | What TikTok played |
| :-- | :-- |
| 1080p H.264, 25 to 50 Mbps | 576×1024, 30 FPS, about 0.6 Mbps |
| 1080p HEVC, 7.5 Mbps, no patch | 576×1024, 30 FPS, 0.62 Mbps |
| **1080p HEVC, 7.5 Mbps, with the patch** | **1080×1920, 60 FPS, 7.75 Mbps (original)** |
| **4K H.264, 40 Mbps, with Variant 3** | **2160×3840, 60 FPS, 40.5 Mbps (original)** |

## How it works

1. Your browser opens the video and converts it with its own video encoder (WebCodecs).
2. The optional enhancer runs on your graphics card (WebGL2) for every frame. Real HDR files are
   not possible from a browser yet, so the HDR option is a look, not a 10 bit HDR file.
3. For TikTok, a small patch changes only the file's info, not the video. Variants 1 and 2 use the
   free CompressBase API, which only receives the file info. Variant 3 and all 4K videos are
   patched right in your browser.

The site has a strict security policy, and the one outside library it loads is locked to a checked
version.

## Built with

JavaScript (no build step) · WebCodecs · WebGL2 · Mediabunny · Node.js tests · GitHub Actions ·
GitHub Pages

## Run it on your computer

You need Node.js 20 or newer. There is nothing to install.

```bash
npm start   # then open http://localhost:5173
npm test    # runs the 56 tests
```

Works best in Chrome or Edge on a computer.

## Limits

* 120 FPS on TikTok is not tested yet.
* Videos are kept in your browser's memory, so files stay under 1 GB.

## Credits

* [Mediabunny](https://mediabunny.dev) (MPL 2.0 license) for reading and writing video files.
* [CompressBase](https://compressbase.com) for the Method API, used with the owner's permission.
* Not connected to TikTok.

## License

[MIT](LICENSE)
