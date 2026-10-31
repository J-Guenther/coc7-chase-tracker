# CoC 7e Chase Tracker

Phone-first helper for Keepers running Call of Cthulhu 7th edition chases. Plain HTML/CSS/JS, no build step.

## Features
- Setup: terrain (9 settings), environment (calm / normal / hazardous), participants with MOV, DEX, speed-roll result, quick-add presets.
- Speed check: works out who escapes and who falls behind, then places everyone on the track by the book rules.
- Track of locations with random hazards and barriers (01–59 clear, 60+ Regular, 85+ Hard, 96+ Extreme). Locations are revealed ahead as the chase moves.
- Turn order by DEX, movement-action pips, owed actions carried into the next round.
- Hazard dialog: cautious bonus dice, acceleration penalty dice, d100 roller with success levels, 1D3 delay and damage rolls, breaking through barriers.
- Sudden hazards that alternate between Keeper and players, placed by tapping a gap.
- Undo, autosave in the browser, works offline once loaded, rules quick reference.

## Run locally
Open `index.html` in a browser. To test the offline mode, serve the folder, e.g. `npx serve .`.

## Deploy to GitHub Pages
```sh
git init
git add .
git commit -m "Chase tracker"
git branch -M main
git remote add origin https://github.com/<you>/coc-chase-tracker.git
git push -u origin main
```
On GitHub, go to **Settings → Pages**, set **Source: Deploy from a branch**, then choose `main` and `/ (root)`. The app is then at `https://<you>.github.io/coc-chase-tracker/`.

On your phone, use **Add to Home Screen** to get it full-screen.

When you change files, bump `VERSION` in `sw.js` so phones pick up the update.

The rulebook PDF is listed in `.gitignore`. Keep it out of the public repo.
