# Retirement Runway

A year-by-year retirement financial-health model with Monte Carlo simulation,
joint/individual household planning, semi-retirement modeling, and more.

## Getting it into CodeSandbox

**Option A — drag and drop (fastest)**
1. Go to https://codesandbox.io/
2. Click "Create" → "Import Project" (or just drag the unzipped folder onto
   the CodeSandbox dashboard).
3. Upload/drop this whole folder. CodeSandbox will detect `react-scripts` in
   `package.json` and set it up as a Create React App project automatically.

**Option B — via GitHub**
1. Push this folder to a new GitHub repo.
2. In CodeSandbox, choose "Import from GitHub" and paste the repo URL.

**Option C — paste into a blank sandbox**
1. Create a new "React" sandbox on CodeSandbox.
2. Replace the generated `src/App.js` with `src/App.jsx` from this folder
   (rename to `.jsx` in CodeSandbox, or update the import in `index.js`
   accordingly).
3. Add `recharts` and `lucide-react` as dependencies via the CodeSandbox
   dependency panel (left sidebar) — they'll install automatically.

## Local development

```
npm install
npm start
```

## Notes

- Data persistence uses the browser's `localStorage` (key
  `retirement-runway-inputs-v2`), so your inputs will survive a page reload
  in the same browser.
- Fonts (Fraunces, Inter, IBM Plex Mono) load via a Google Fonts `@import`
  inside the component itself — no extra setup needed.
