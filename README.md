# MyTube

A macOS Electron app that archives YouTube lectures: paste a video URL and it downloads the video, the transcript, and slide images extracted from the frames — then keeps everything in a browsable library.

## Features

- **Video download** — best available quality, merged into a single `mp4`/`mkv` via yt-dlp + ffmpeg.
- **Transcripts** — plain-text `transcript.txt` plus per-language `.srt` files, with language selection when multiple tracks exist.
- **Slides** — JPEG frames captured at scene changes (timestamped filenames) with a generated HTML gallery, ideal for lecture/presentation videos.
- **Library** — left-hand sidebar of everything downloaded, with a detail view: inline video playback, transcript preview, and slide gallery. Custom output folders are remembered as library roots.
- **Delete** — remove downloads you no longer need via the trash icon on a library row (or `Delete…` in the detail view); a confirmation dialog guards the permanent removal of the folder from disk.
- **Resilient tooling** — yt-dlp is auto-downloaded on first launch and validated with a `--version` probe (corrupt binaries are removed and re-fetched); ffmpeg ships bundled via `ffmpeg-static`.

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 18+ (for development only)

## Getting started

```sh
npm install
npm start
```

On first launch the app fetches the yt-dlp binary for your platform into its user-data folder. Paste a YouTube URL, pick the transcript languages, choose an output folder, and hit **Download**.

Only single-video URLs are accepted; playlist links are rejected with a clear message.

## Output layout

Downloads land in `~/Downloads/MyTube/<video title>/` by default (or any folder you pick):

```
<video title>/
├── video.mp4              # merged video (mkv/webm/mov possible)
├── transcript.txt         # plain text, all selected languages
├── transcript.en.srt      # one per selected language
├── slides/
│   ├── slide_0001_00-00-00.jpg   # scene-change frames, named by timestamp
│   ├── slides.json               # frame → timestamp index
│   └── index.html                # browsable gallery
└── meta.json              # title, channel, duration, thumbnail, date
```

## Tests

| Command | What it does |
| --- | --- |
| `npm test` | 12 fault-injection regression tests (path escapes, killed connections, hanging servers, corrupt binaries, symlink containment, delete guards, …) |
| `npm run test:e2e` | Real end-to-end download of "Me at the zoo" into `test/output/` |
| `npm run test:ui` | Drives the real UI over Chrome DevTools Protocol: fetch → download → library → detail, with screenshots |
| `npm run test:ui-delete` | CDP proof of the delete flow: trash icon → dialog → Escape/Cancel → detail Delete → confirm, with screenshots |

The regression and e2e suites run under Electron; the UI test needs the app running with `--remote-debugging-port=9222` (see `test/ui-test.js`).

## Packaging

```sh
npm run dist   # builds an unsigned macOS .dmg into dist/
```

## CI/CD

GitHub Actions (`.github/workflows/`):

- **CI** (`ci.yml`) — on every PR and push to `main`: syntax check, the fault-injection suite under `xvfb`, and an `electron-builder` Linux packaging smoke build.
- **Release** (`release.yml`) — pushing a `v*` tag builds macOS dmgs for arm64 and x64 and attaches them to a GitHub Release with generated notes. Can also be triggered manually via `workflow_dispatch`.

## Project structure

```
src/
├── main.js          # Electron main: window, IPC, media:// protocol
├── preload.js       # contextBridge API (sandboxed, context-isolated)
├── binaries.js      # yt-dlp download/validation, ffmpeg resolution
├── downloader.js    # yt-dlp orchestration, transcript + slide extraction
├── library.js       # library roots, folder scanning, transcript preview
└── renderer/        # vanilla-JS UI (download view + library/detail view)
test/                # regression, e2e, and CDP UI tests
```

## Notes

- The renderer runs with a strict CSP; local media is served through a custom `media://` protocol restricted to library folders (symlink-safe).
- Intended for archiving content you have the rights to download. Respect YouTube's Terms of Service.