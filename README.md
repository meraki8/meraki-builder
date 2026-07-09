# Meraki Builder

A quiet visual page builder for the [Meraki theme](https://github.com/meraki8/meraki-theme).
Part of PROJEC+ MERAKI.

The editor is a React app (dnd-kit for drag and drop) on a full-screen
admin page. The front end is plain PHP: each node renders as one element
with a stable `.m-{id}` class — no JS, no inline styles, no editor
artifacts. Builder pages render on the theme's Full Width template.

## Structure

- `meraki-builder.php` — bootstrap, update checker.
- `includes/` — editor page, REST save endpoint, sanitizer, front-end renderer.
- `src/` — editor source (React); bundled to `editor/build/editor.js` with esbuild.
- `assets/` — front-end layout classes (uses the theme's design tokens) and editor chrome.
- `includes/plugin-update-checker/` — vendored [plugin-update-checker](https://github.com/YahnisElsts/plugin-update-checker) (v5).

## Data model

One JSON tree in `_meraki_builder_tree` post meta. Every node:
`{ id, type, props, css, children }` — props are structure and content
only, never appearance; `css` is a per-node escape hatch where the word
`selector` resolves to `.m-{id}` (empty ships zero bytes). The tree is
whitelisted server-side on save.

## Develop

```
npm ci
npm run build   # bundles src/ -> editor/build/editor.js
```

## Releasing

1. Update `Version:` in `meraki-builder.php` and add a CHANGELOG section.
2. Commit, tag `vX.Y.Z`, push. CI builds the editor bundle, stages the
   plugin into a folder named exactly `meraki-builder` (the folder name is
   the plugin's identity — never version it), and attaches
   `meraki-builder.zip` to a GitHub Release.
3. **Confirm consumption on a real wp-admin** (same routine as the theme):
   on a WordPress install running the previous version, force an update
   check — the update notice must appear with no `puc-invalid-metadata`
   error, and one-click update must complete. "The endpoint serves JSON"
   is not sufficient proof; the plugin and theme metadata schemas differ
   and only wp-admin exercises the real parser.

Latest zip: `https://github.com/meraki8/meraki-builder/releases/latest/download/meraki-builder.zip`
Update endpoint: `https://projec-meraki-app-production.up.railway.app/updates/meraki-builder.json`
