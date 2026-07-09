# Changelog

All notable changes to Meraki Builder are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/meraki8/meraki-builder/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/meraki8/meraki-builder/releases/tag/v0.1.0
