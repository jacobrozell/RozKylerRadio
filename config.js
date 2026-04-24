/* eslint-disable */
// Default: playlist + audio use paths relative to this HTML file (works on GitHub Pages
// at https://USER.github.io/REPO/ and when you `npx serve` the repo root).
//
// Only set mediaBase if audio lives elsewhere on the same host, e.g. serve the app from
// /Projects/.../radio/ but files at /Renders/... then: mediaBase: "/"
window.RADIO_CONFIG = {
  basePath: "",
  playlistUrl: "playlist.json",

  // After `wrangler deploy`: likeEndpoint: "https://rozkyler-radio-like.YOUR_SUBDOMAIN.workers.dev"
  // Steps: like-discord-setup.txt
  likeEndpoint: "",
  // If your worker checks X-Like-Secret (weak anti-spam; visible in page source):
  likeSecret: "",
};
