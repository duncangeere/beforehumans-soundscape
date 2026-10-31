# Before Humans — Soundscape Loop Creator

Browser tool for making seamless looping nature soundscapes from Freesound samples.

Search for sounds, stack them as layers, adjust volume/trim/offset/looping, preview the mix, export as WAV.

## Setup

Get a free [Freesound API key](https://freesound.org/apiv2/apply/), then:

```bash
python3 server.py
# http://localhost:8000
```

The server proxies Freesound audio files (their CDN lacks CORS headers). It only listens on your own machine, and the proxy only fetches from Freesound's domains.

## Files

- `index.html` — page, styles, UI
- `server.py` — static file server + Freesound audio proxy
- `js/soundscape.js` — app logic, layer management, UI
- `js/freesound.js` — Freesound API client
- `js/audio-engine.js` — Web Audio playback, crossfade rendering, WAV export

Vanilla JS, no build step.
