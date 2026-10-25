# Instagram Reels Downloader

A responsive Node.js/Express app that attempts to retrieve **publicly accessible** Instagram Reels and posts using [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Deploy on Render

This repository includes a Dockerfile. Create a Render **Web Service** using this repository and select **Docker** as the runtime. Use the repository root as the Docker context and Dockerfile path. The app listens on the `PORT` environment variable.

## Run locally

Requirements: Node.js 20+, Python 3, pip, and FFmpeg.

```bash
python3 -m pip install -U yt-dlp
npm install
npm start
```

Open http://localhost:10000.

## Limits

Instagram may require login, restrict requests, or change its media delivery. Private, login-protected, or otherwise inaccessible media will not work. This app does not bypass authentication or access controls. Use it only for content you own or are authorized to download, and respect Instagram's terms and copyright.
