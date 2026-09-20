# Anurag Thakur — portfolio

A plain static site: no build step, no framework. Keep all files in the same folder.
Open `index.html` directly, or upload the folder to GitHub Pages / Netlify / any host.

| File | What it is |
| --- | --- |
| `index.html` | The main page |
| `portfolio-snapshot.html` | The print-ready one-pager (linked from Downloads) |
| `styles.css` | Your compiled stylesheet, unchanged, plus a small "Additions" block at the end |
| `main.js` | Theme toggle, scroll effects, typewriter, tabs, counters, skill bars, contact form |
| `fluid.js` | The WebGL fluid background |

## Things you might want to change

- **Fluid feel** – `CONFIG` at the top of `fluid.js`
  (`CURL` = swirliness, `DENSITY_DISSIPATION` = how fast colour fades,
  `BURST_COLOR` / `BURST_FORCE` = the splash when you hover your name).
- **Typewriter words** – `ROLES` at the top of `main.js`.
- **Contact form** – `FORM_ENDPOINT` at the top of `main.js` (currently the Readdy form endpoint
  from your export; swap in Formspree, Web3Forms, etc. if you stop using Readdy).
