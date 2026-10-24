# Fast Lossless for BitChord

A small Node.js HTTP addon with bounded upstream requests, 60-second search caching, and two sources: (1) FLAC files in Internet Archive records, and (2) a personal FLAC library in `./music`.

Use only public-domain or appropriately licensed Internet Archive audio. This project does not access paid streaming accounts or convert lossy audio to FLAC.

## Run

Requires Node.js 20+.

```sh
npm start
```

Open `http://127.0.0.1:8080/manifest.json`, `/health`, and `/search?q=Beethoven` to test.

## Personal library

Create a `music` folder and put your own FLAC files in it. Filenames like `Artist - Track.flac` improve display. The addon supports HTTP byte-range streaming for local files.

## Add to BitChord

BitChord's public addon contract is not documented as a stable API, so test the manifest with the app's Add Custom Provider/Test control. For phone + PC on the same Wi-Fi, enter `http://YOUR_PC_LAN_IP:8080`. For reliable use away from home, deploy behind HTTPS and set `PUBLIC_BASE_URL` to that public HTTPS base URL.

If the app rejects a manifest field, use the exact schema error from BitChord's Test control to adjust it; addon schema compatibility can vary by app version.
