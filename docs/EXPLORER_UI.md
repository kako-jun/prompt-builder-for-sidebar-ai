# Explorer UI

The session page (`GET /{token}`) is a two-pane explorer: a resizable left
pane with the file tree, selection presets, a path filter, and a recently
opened list; a right pane that renders every checked file's content as its
own collapsible panel. It defaults to a dark theme and is implemented as
plain HTML/CSS/JS (`assets/index.html`, `assets/style.css`, `assets/app.js`,
all embedded in the binary at build time) with no external network
dependency and no build step. A dismissible notice at the top of the page
restates this README's disclaimer: content copied from here goes to
whichever third-party AI the user pastes it into, and the files opened here
should themselves be treated as untrusted input (see "Security notice" below
for its dismiss/reopen behavior).

The app icon (`assets/icon.png`) is embedded too and inlined as a `data:`
URI -- serving as the page favicon (`<link rel="icon">`), an
`apple-touch-icon` link, and the small logo badge at the very top-left of the
explorer pane -- so it costs no extra request. The `<link rel="icon">` means
the browser never probes `/favicon.ico` (no more 404 for it). The
`apple-touch-icon` link is best-effort: some iOS Safari versions ignore a
`data:` URI there and fall back to a screenshot thumbnail when the page is
added to the home screen, which does not apply to this tool's normal
localhost-tab usage. The logo sits next to the full app name, shown as
always-visible text (issue #35; issue #15 had originally left the name
hover-only, in the logo's `alt`/`title`, which stay as a tooltip/fallback).
The name is a proper noun, so it's identical in every locale, and shrinks
with an ellipsis rather than overflowing the row at the explorer-pane's
220px minimum width. The logo itself is intentionally not a link or button
-- this is a single-root-per-session tool, so there is nowhere to navigate
"home" to (that becomes meaningful once issue #11 adds a root picker).

## Security notice (dismiss / collapse in place)

`#security-notice` originally shipped (issue #9) with no dismiss control at
all, on the theory that a security disclosure shouldn't be something a user
mutes once and never sees again. Issue #28 reversed that decision based on
real usage: pinned for the whole session, the notice became pure noise after
the first read, and its original wording ("content copied from this page may
be pasted into a third-party AI...") read as if the tool itself were the
danger rather than naming the actual risk. See `THREAT_MODEL.md` for the full
before/after rationale.

The current behavior:

- The notice shows once, the first time the page loads with no stored
  dismissal.
- A close button (✕) dismisses it and persists that choice to `localStorage`
  (`pbsa-security-notice-dismissed`), the same best-effort pattern as the
  locale/recent-files choices -- a private-browsing or storage-disabled
  context just won't remember the dismissal across reloads.
- Issue #28 first re-showed the dismissed notice via a separate "🛡 Safety"
  button living in the brand row -- a different location from the ✕ that
  closed it. Issue #36 replaced that with an in-place collapse: dismissing
  the notice doesn't hide it entirely, it collapses the same top-of-page slot
  into a thin "🛡 Safety notice" strip (`#security-notice-collapsed`).
  Clicking that strip expands the full notice again, clearing the stored
  dismissal (so it goes back to showing in full on the next load too, rather
  than staying silently "seen forever" once you've chosen to look at it
  again). Exactly one of the full notice / the collapsed strip is visible at
  any time, in that same position -- there's no separate reopen control
  anywhere else in the UI.
- The wording itself was rewritten to name the two actual risk points
  directly: files opened here are untrusted input (their content can include
  text written to steer an AI), and whatever gets copied out is handed to
  a third-party AI this tool has no control over. What to share remains the
  user's call either way -- the notice discloses, it doesn't gate anything.

## Quick select chips

The four selection shortcuts ("All text files", "Source only", "Docs only",
"Clear selection") render under a "Quick select" heading as small pill-shaped
chips, each with a decorative inline SVG icon (`aria-hidden="true"`, matching
the pattern used by the search filter icon and the embedded app logo -- no
icon font, no external asset). They're deliberately lighter-weight than
primary action buttons elsewhere in the UI (e.g. "Generate prompt") since
each is a one-shot shortcut that replaces the current checked-file set rather
than a committal action. "Clear selection" uses a dashed, ghost-style
treatment (no fill, muted border) to read as a reset action distinct from the
three additive presets, and stays pushed to the right of the row. The
row keeps its `data-preset` attributes and `role="group"` grouping; only the
visual weight changed.

## Recently opened files

The "Recently opened" list sits directly under the quick-select chips and is
styled as part of the same shortcut family (issue #26) rather than a
disconnected list: its heading carries a small decorative clock/history
icon (same inline-SVG, `aria-hidden="true"` pattern as the chip icons), and
each row gets a small curved-arrow reopen icon before the filename so it's
visible without trial and error that clicking a name re-selects/reopens that
file (`✕`, at the end of the row, remains the separate "remove this one
entry" action). Row borders, hover state, and muted colors reuse the same
palette tokens as the chips above (`--text-dim`, `--border`, `--accent`,
`--danger`) so the two sections read as one family while the list keeps its
original (non-chip) layout, since recent files can be more numerous than the
four fixed presets.

The section's own clear-all button is labeled "Clear history" / "履歴をクリア"
-- deliberately distinct from the quick-select row's "Clear selection" /
"選択をクリア" chip, since the two do different things (wiping the whole
recent-files history vs. unchecking the current selection) and previously
shared the ambiguous word "Clear". The section's accessible name now comes
from `aria-labelledby` pointing at the visible `<h2>` (`id="recent-title"`)
instead of a separately maintained `aria-label`/`data-i18n-aria` pair, so the
label text has one source of truth.

## Language (English / Japanese)

The UI ships in two languages -- English (the source and fallback) and
Japanese -- selectable from a small language toggle at the top of the
explorer pane. The toggle's `<label>` ("Language"/"言語") is
`.visually-hidden` rather than rendered text -- the select's own selected
option already reads "English"/"日本語", so a second, always-identical label
next to it was pure noise in the already-tight brand row; the label stays in
the DOM so the select still has an accessible name for screen readers. A
single active locale drives **both** the interface chrome
(labels, buttons, preset names, the security notice, toasts, aria-labels) and
the text of the prompt the composer generates, so switching languages
localizes everything at once, not just the surrounding UI.

The active locale is resolved on load in this order:

1. A previously stored choice in `localStorage` (`pbsa-locale`) wins.
2. Otherwise `navigator.language` is consulted: a value starting with `ja`
   auto-selects Japanese; anything else falls back to English.

Choosing a language from the toggle re-renders the whole UI immediately and
persists the choice to `localStorage` (best-effort -- a private-browsing or
storage-disabled context still switches for the session, it just won't be
remembered). Every user-visible string lives in a single message catalog
(`MESSAGES` in `assets/app.js`) keyed by meaning; a key missing a Japanese
translation falls back to the English string rather than rendering blank, so
a partial translation can never produce an empty label.

Switching the language also updates the generated prompt: if the prompt in
the result textarea is still exactly what the composer last generated (i.e.
untouched), it is regenerated in the new language; if it has been hand-edited,
it is left as-is so a language switch never discards manual edits.

This "localize everything" rule covers the transient status prose too, not just
the fixed labels: the Git-diff target's status lines ("no local changes", "not
a Git repository", a failed diff fetch) and a file/tree/root load-failure
message are all drawn from the catalog and re-rendered on a language switch, so
none of them can leave an English string stranded (or blank the tree) after the
user changes languages. Only the embedded technical detail -- a path, an HTTP
status -- stays verbatim, since it isn't language-specific.

## Line numbers, stable references, and URL navigation

Each open file panel shows 1-based line numbers down its left edge; they are
excluded from text selection, so dragging across the code to copy it never
picks up the line numbers themselves. Clicking a line number selects that
single line; Shift-clicking extends the selection to a range from the last
plain click.

Every file panel's heading always shows its stable `@file:<path>` reference,
and while a line range is selected the panel also shows the matching
`@lines:<path>#L<start>-L<end>` reference (a single selected line omits the
`-L<end>` part, e.g. `@lines:src/app.js#L42`). A directory's reference
(shown when navigated to, see below) is `@dir:<path>`.

These reference strings double as the page's URL fragment: `location.hash`
holds one, percent-encoded, so the current directory or line selection can be
bookmarked or shared as a link. Loading a URL with an `@dir:` fragment
expands and scrolls the file tree to that directory; an `@file:`/`@lines:`
fragment scrolls to and briefly highlights the matching already-open file
panel (applying the line selection first, for `@lines:`). Opening a file
automatically from a fragment is out of scope: if the file isn't open yet,
an `@file:`/`@lines:` fragment is a no-op.

## Copy actions and output formats

Every place content can be copied -- a file panel's header, a directory row
in the tree (hover to reveal), and the content pane's global toolbar -- shows
the same control: an always-visible primary button plus a "⋯" button that
opens a menu of the other output formats and actions (a reference-only copy,
and, once a line range is selected, a reference-plus-code copy). The primary
button always copies as Markdown, and its label says so ("Copy file as
Markdown" / "Copy all checked as Markdown", reusing the same "Copy … as
{format}" phrasing as the "⋯" menu's other format entries) rather than
leaving the format implicit; the "⋯" menu covers the rest.

There are four output formats:

- **plain**: a path heading, an underline, and the file's content verbatim.
  The minimal format -- file boundaries between multiple files are only as
  unambiguous as a human reading the headings makes them.
- **markdown**: a `### <path>` heading followed by a fenced code block
  (escalating the fence length whenever the content itself contains
  backticks that would otherwise close it early).
- **xml**: a `<file path="...">...</file>` element (multi-file copies are
  wrapped in a single `<files>`). This isn't decoration -- it exists so an AI
  reading multiple concatenated files can't mistake where one file's content
  ends and the next one's path begins, something plain/markdown headings
  alone can't fully guarantee.
- **diff**: deliberately almost identical to plain for now. A future issue
  will feed a real `git diff` through this same slot; today it's just a
  correct receptacle for that content, not a synthesized fake diff.

A successful or failed copy is reflected right on the button that triggered
it (a transient "Copied!"/"Copy failed" label). A multi-file copy re-fetches
every file's content before writing to the clipboard, which can take long
enough that an unrelated re-render (e.g. toggling a checkbox) removes that
button from the page first; when that happens, the same feedback appears
instead as a toast notification in the corner of the page, so the result is
never silently lost.

## Prompt composer

A collapsible "Prompt composer" panel sits at the top of the content pane.
It builds an editable prompt from four choices, plus optional free-form
instructions, matching the goal/target/output/context-mode model from the
project's design:

- **Goal**: find relevant code, explain code, investigate a bug or its
  impact, review design or security, compare/synthesize across sources
  (issue #39 -- asks for a structured summary of the checked sources'
  similarities and differences, aimed at sidebar AIs that can compare
  multiple open tabs/files at once, e.g. Gemini in Chrome or Copilot in
  Edge), extract test cases, suggest refactoring, or plan implementation.
- **Target**: the whole page, the checked files, the currently selected line
  range(s), or the Git diff. Choosing "Downloadable file" as the output also
  reveals a filename field, whose value is embedded in the prompt as an
  explicit "generate a downloadable file named `<name>`" instruction (falling
  back to `output.md` if left blank).
- **Output**: concise answer, investigation report, GitHub issue,
  implementation instructions, checklist, unified diff, or a downloadable
  file.
- **Context mode**: "Page context only" generates just the prompt text,
  relying on the sidebar AI reading the live page itself; "Referenced
  excerpts" embeds the currently selected line range(s) from every file with
  an active selection; "Full selected files" embeds the full content of every
  checked file; "Attach as files, don't paste" (issue #39) embeds neither --
  it lists the checked files by reference and instructs the sidebar AI's
  *operator* to attach them directly via that AI's own native file-attachment
  control (e.g. Gemini in Chrome's upload icon, Copilot in Edge's paperclip),
  which skips fetching file content entirely (same optimization as "Page
  context only"). The Context mode field's tooltip also notes, for the human
  operator rather than the generated prompt text, that Gemini in Chrome can
  reference other open tabs with `@` and that Copilot in Edge's use of page
  context ("Context Clues") depends on how the prompt is phrased.

Every combination of these four choices produces a complete, readable prompt
-- including edge cases like "Referenced excerpts" with nothing currently
selected, which embeds an explanatory placeholder instead of silently
omitting the context section. Target "Git diff" embeds the current diff (via
`GET /{token}/api/diff`, see [API.md](API.md)) under the "## Context" heading
for "Referenced excerpts"/"Full selected files"/"Attach as files, don't
paste" alike (there's no separate "just an excerpt of the diff" mode -- a
diff is already a purpose-built excerpt of the changes, and "attach this as a
file" doesn't map onto an in-memory diff either, so all three behave the same
for this target). "Page context only" is
honored, not overridden: unlike every other target, a diff is never actually
rendered anywhere on the page for a sidebar AI to read on its own, so the
usual "just read the live page" assumption doesn't hold for it -- rather than
silently embedding the diff anyway (uncommitted changes routinely contain
secrets or work-in-progress code a user may deliberately not want handed to a
third-party AI), the Context section explains that and suggests switching
context mode. If the selected root isn't a Git repository, or there are no
local changes, it says that in plain language instead, in either case never
appearing empty or broken.

Clicking "Generate prompt" (re)writes the result textarea from the current
choices; the result is otherwise freely editable, and "Copy prompt" always
copies whatever is currently in that textarea (including manual edits), not
a freshly regenerated version.

Both buttons carry a small notification-dot badge (issue #43) that tracks
whether the two of them are in sync with the rest of the composer. "Generate
prompt" lights up whenever any composer input changes after the last
generate — either of the four selects, the filename field, the additional-
instructions field, the checked-file selection (individually, via a preset,
or via "reopen" from the Recently-opened list), or a line selection — and
goes dark once generation actually completes, not the instant "Generate
prompt" is clicked: for target "diff" (any context mode but "page") or
context mode "excerpts"/"full", that means once the in-flight embed-content
fetch resolves, not before. "Copy prompt" lights up
right after a successful generate (there's a fresh result that hasn't been
copied yet) and goes dark once "Copy prompt" is clicked and the copy actually
succeeds; a failed copy leaves it lit, since there's still nothing copied.
Changing any composer input after a generate turns "Generate prompt" back on
and "Copy prompt" back off, since the freshly generated text is no longer
current either. Hand-editing the result textarea itself does not affect
either badge -- that's a different concept from a composer input changing
(see "Language (English / Japanese)" above for the similar-but-distinct "was
this hand-edited" check the language switcher makes). Neither badge is
color-only: "Generate prompt" carries its hint in a `title` tooltip, and
"Copy prompt" carries its hint in `aria-label` (not `title`, which briefly
belongs to the transient "Copied!"/"Copy failed" feedback instead).

"Excerpts"/"full file" context mode and target "diff" fetch their embedded
content asynchronously, and a locale switch can also trigger a regenerate; if
a composer input changes, or another generate starts, while one of these is
still in flight, the stale generation finishes without writing anything --
the result textarea and both badges are left exactly as they were, so a
newer change is never silently overwritten by an older, now-outdated result.

## Selection size statistics

The content toolbar shows a single live line of statistics for the currently
checked selection: file count, total character count, and an estimated token
count, updating as files are checked/unchecked and as each one's content
finishes loading (a checked-but-still-loading file counts toward the file
count immediately but not yet toward the character count, and is called out
explicitly, e.g. "3 files selected (1 still loading)", rather than silently
under-reporting the total). This one line also doubles as the open-file
count: checking a file opens its panel and unchecking closes it, so the
checked count and the open-file count converge to the same value (issue #38
merged what used to be two lines into this single line). They can differ for
a moment right after checking several files at once -- panels open one fetch
at a time, so the open-file count catches up gradually rather than jumping
immediately -- but the merged line's "still loading" phrasing already covers
that transitional state, whereas the old two-line layout could briefly show
two directly conflicting numbers (e.g. "1 file open" next to "10 files
selected (10 still loading)") for the same instant. Past roughly
200,000 characters the line also gets a "⚠ large selection" warning -- a
soft, order-of-magnitude heuristic meant to catch an accidental
"select-everything", not a hard limit enforced anywhere.

The token count is deliberately labeled "(rough estimate)": it is computed as
`characters ÷ 4`, a widely-used approximation for English-ish source/prose
text, not a real tokenizer for any specific model. This tool is vendor-neutral
and has no access to (and makes no attempt to replicate) any particular AI
provider's actual tokenizer, so the estimate can be meaningfully off --
especially for text that isn't English-like prose (dense symbolic code,
non-Latin scripts, minified/generated files) -- and should be read as an
order-of-magnitude sense of size, not a precise count.
