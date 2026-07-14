# Changelog

## v0.3.0 — 2026-07-14

### Added

- **"Open another folder" action.** A button next to the explorer root label
  triggers a native OS folder-picker (via the `rfd` crate), run by the local
  backend — the browser never receives arbitrary filesystem access.
  Selecting a folder replaces the active root without restarting the CLI:
  the explorer tree, checked files, open panels, and any generated prompt
  are all cleared and rebuilt against the new root. Canceling the dialog
  leaves the current root untouched, and the previous root becomes
  unreachable through every existing endpoint immediately. On a headless
  Linux session with no `$DISPLAY`/`$WAYLAND_DISPLAY`, this is reported as a
  distinct "no dialog available" outcome rather than a silent hang.
- A small notification-dot badge on the Generate/Copy buttons: it lights up
  on Generate when the composer's current inputs no longer match what was
  last generated ("needs regenerating"), and on Copy once a freshly
  generated prompt hasn't been copied yet ("needs copying"). Neither badge
  depends on color alone — each also carries a text hint (`title`/
  `aria-label`).
- A successful "Copy prompt" click now nudges toward this tool's actual next
  step: instead of the plain "Copied!", it reads "Copied! Paste it into your
  sidebar AI." Every other copy action (file panel Copy, directory copy,
  "Copy all checked") is unchanged.

### Changed

- The default Copy buttons ("Copy" on a file panel, "Copy all checked") now
  name their output format explicitly — "Copy file as Markdown" / "Copy all
  checked as Markdown" — matching the "⋯" menu's existing "Copy file as
  {format}" phrasing instead of a bare, ambiguous "Copy".

## v0.2.0 — 2026-07-13

### Added

- **"Compare / synthesize across sources" Goal.** Generates an instruction
  asking for a structured comparison across the selected/checked files,
  rather than a single-subject investigation. Added based on a 2026 survey
  of Gemini in Chrome / Copilot in Edge, both of which treat cross-tab
  comparison as a headline feature.
- **"Attach as files, don't paste" Context mode.** Instead of embedding file
  content inline, generates a short instruction plus a list of the checked
  file paths, telling the reader to attach those files natively via the
  sidebar AI's own attachment button (Gemini's upload icon, Copilot's clip
  icon — up to 20 files/50MB per Microsoft's docs). No extra fetch: the file
  list is built from data already gathered for the composer, the same way
  "page context only" already avoided fetching content it would discard.
  For a Git-diff target, this mode falls back to embedding the diff inline
  (same as "excerpts"/"full"), since an in-memory diff isn't a file that can
  be attached.
- A brief tooltip on the Context mode select noting Gemini's `@tab`
  reference syntax and Copilot's phrasing-dependent context use — a hint for
  the person operating the composer, not part of the generated prompt text.

### Changed

- The app name ("prompt-builder-for-sidebar-ai") is now always shown as text
  next to the logo in the explorer pane's brand row, not just in the icon's
  `alt`/`title` tooltip.
- The security notice's dismiss/reopen controls are now in one place: closing
  it collapses the same top-of-page banner into a thin strip (rather than
  hiding it entirely and moving the reopen control into the sidebar), so
  dismiss and reopen are the same visual location instead of opposite
  corners of the page. The sidebar's separate "🛡 Safety" reopen button is
  gone.
- The content-pane toolbar's "N files open" and "N files selected · ..."
  lines are merged into one, removing a moment where the two counts could
  show directly conflicting numbers during a bulk file-check (checking
  panels open sequentially as each file's content loads, while the selected
  count updates immediately).
- The Goal dropdown is reordered to follow typical usage order: locate →
  explain → investigate a bug → review → compare → extract tests → refactor
  → plan.
- The locale switcher's "Language"/"言語" text label is now visually hidden
  (still present for screen readers) — the select's own selected option
  already reads "English"/"日本語", so the separate label was redundant.

## v0.1.0 — 2026-07-12

Initial release. See the README for the full feature set at launch: the
two-pane explorer, quick-select presets, recently-opened history, the
prompt composer (goal/target/output/context mode), Git diff mode, and the
security safeguards documented in THREAT_MODEL.md.
