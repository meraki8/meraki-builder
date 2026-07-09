# Changelog

All notable changes to Meraki Builder are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-10

### Added

- Elements tree panel (left sidebar, below the palette): full hierarchy
  with expand/collapse, text previews, two-way selection sync with the
  canvas, hover highlighting, per-row delete, and drag-reorder using the
  same DnD rules as the canvas — except the tree never auto-wraps:
  root-level non-container drops are rejected with feedback.
- Undo/redo: history over the immutable tree (add/delete/move/prop/css),
  text typing coalesced per field, toolbar buttons plus Cmd/Ctrl+Z,
  Shift+Cmd/Ctrl+Z and Ctrl+Y, capped at 100 steps, selection restored
  with each step. Session-only; saving is not a history event.
- Container padding prop (none/sm/md/lg, default none) mapped to the
  theme's spacing tokens — the only front-end change; existing pages
  render exactly as before.

## [0.1.2] - 2026-07-10

### Changed

- Canvas affordance pass (editor-only, zero front-end changes): hover and
  selection now show an Elementor-style handle bar (type label, drag grip,
  add-sibling-container, delete) on the innermost hovered node; containers
  get accent hover outlines.
- Clear visual hierarchy: quiet inner "Drop widgets here" hint for empty
  containers vs a distinct page-level "+ Add Section" appender (click to
  add a section; still the same root-level drop target).
- Insertion indicator is thicker with end caps, unmistakable against
  hover outlines.

## [0.1.1] - 2026-07-10

### Added

- Persistent drop zone below the last root-level row: dropping there
  always creates a new root-level section, never nests.
- Clear insertion indicators between root-level containers while dragging.

### Changed

- Only containers live at canvas root: dropping any other widget at root
  auto-wraps it in a new container (one drop, both created). Enforced
  server-side on save as well.
- New containers default to full width — the outer container is the
  section band, a nested contained container wraps content. Existing
  saved trees are untouched.
- Wider edge zones when dragging (28px nested, 40px at root): landing as
  a sibling is now the easy gesture, nesting the deliberate one.

## [0.1.0] - 2026-07-10

### Added

- Milestone 1 of the Meraki page builder: full-screen editor (React +
  dnd-kit) with a widget palette, canvas, and Block/Page settings panels.
- Two widgets: container (direction, gap, width) and text (h1–h6/p).
- Drag and drop: palette-to-canvas insertion, reordering, moves between
  nested containers, edge-zone sibling drops, insertion indicator, and
  invalid-drop feedback. Only containers accept children; depth capped.
- Immutable JSON node tree stored in post meta; every node carries a
  stable id (also its .m-{id} CSS hook) and an optional custom CSS field
  where "selector" resolves to the node's class.
- Plain-PHP front-end rendering on the Meraki Full Width template: clean
  markup, zero JS, no inline styles or editor artifacts; custom CSS ships
  in a single style element only when non-empty.
- Excerpt/meta-description support for builder pages, derived from the
  tree's text content.
- Server-side sanitization: whitelisted node types and props, css field
  scrubbing, depth cap, capability + nonce checks on save.
- Self-hosted updates via plugin-update-checker pointed at PROJEC+ MERAKI.

[Unreleased]: https://github.com/meraki8/meraki-builder/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/meraki8/meraki-builder/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/meraki8/meraki-builder/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/meraki8/meraki-builder/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/meraki8/meraki-builder/releases/tag/v0.1.0
