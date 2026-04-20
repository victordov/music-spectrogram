# Screenshots

This folder contains the screenshots referenced from the top-level `README.md`.

| Filename | What it shows |
| --- | --- |
| `01-empty-state.png` | Landing page with empty-state illustration + "Play demo" / "Load your own" actions. |
| `02-loaded-static.png` | Static full-track spectrogram right after a song loads, with waveform overview. |
| `03-playback.png` | Playback in progress with playhead cursor + live frequency bars. |
| `04-scroll-mode.png` | Scrolling spectrogram mode while audio plays. |
| `05-brush-tool.png` | Brush armed, cyan ring cursor visible on spectrogram, attenuation stroke painted. |
| `06-alt-mel.png` | Mel spectrogram visualization. |
| `07-alt-chroma.png` | Chromagram with pitch-class labels. |
| `08-alt-scalogram.png` | Complex-Morlet wavelet scalogram. |
| `09-alt-cochleagram.png` | Gammatone cochleagram. |
| `10-alt-waterfall.png` | Waterfall / pseudo-3D spectrogram. |
| `11-alt-features.png` | Spectral features panel (centroid / bandwidth / rolloff / flux / RMS). |
| `12-pro-panel.png` | Pro panel with metering, key/BPM, compliance + anomaly scan. |
| `13-eq-curve.png` | Parametric EQ with on-screen response curve. |
| `14-hunt-mode.png` | Anomaly hunt mode — navigating between hotspots. |
| `15-hover-readout.png` | Hover readout showing time / frequency / note / dB under the cursor. |

## How these were captured

Served the app via `python3 -m http.server 5173`, opened
`http://localhost:5173` in Chrome, loaded `song5.mp3`, then captured each
view at 1600×960 viewport. See the top-level README for the full list.
