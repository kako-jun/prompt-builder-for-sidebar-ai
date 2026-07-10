"use strict";

// The page is served at exactly "/{token}" (no trailing slash), so plain
// relative fetch URLs like "api/root" would resolve against the parent of
// the current path per normal URL-resolution rules and silently drop the
// token. Building every API URL from the current pathname sidesteps that
// without needing any server-side redirect or <base> tag.
const BASE_PATH =
  typeof window !== "undefined" ? window.location.pathname.replace(/\/+$/, "") : "";

const RECENT_STORAGE_KEY = "promptBuilder.recentFiles";
const RECENT_LIMIT = 100;

const MIN_EXPLORER_WIDTH = 220;
const MAX_EXPLORER_WIDTH = 800;

// How long a navigation-target highlight (from a URL fragment jump) stays
// visible before fading back to the normal, unhighlighted look.
const NAV_FLASH_MS = 1500;

const SOURCE_EXTENSIONS = new Set([
  "rs",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "rb",
  "php",
  "sh",
  "css",
  "html",
]);
const DOC_EXTENSIONS = new Set(["md", "mdx", "txt"]);

const state = {
  entries: [],
  rootNode: null,
  nodesByPath: new Map(),
  checked: new Set(),
  expandedDirs: new Set(),
  openFiles: [],
  fileContentCache: new Map(),
  collapsedPanels: new Set(),
  // path -> { anchor, start, end }. `anchor` is the line a plain click last
  // landed on (Shift-click ranges are measured from it); `start`/`end` are
  // the currently highlighted range (start === end for a single-line
  // selection). Tracked per path so selections in different open files never
  // cross-contaminate each other's "last clicked line".
  lineSelections: new Map(),
};

let el = {};

async function init() {
  wirePresetButtons();
  wireSearchInput();
  wireRecentClear();
  wireResizer();
  wireHashNavigation();
  renderRecentList();
  await Promise.all([loadRoot(), loadTree()]);
  // Handle a reference already present in the URL when the page loads (e.g.
  // a bookmarked "@dir:" link). Files are never open yet at this point, so
  // an "@file:"/"@lines:" fragment is necessarily a no-op here; it only
  // takes effect once matched against files opened later in the session.
  handleHashNavigation();
}

function apiUrl(suffix) {
  return `${BASE_PATH}${suffix}`;
}

async function loadRoot() {
  try {
    const response = await fetch(apiUrl("/api/root"));
    if (!response.ok) {
      el.rootBasename.textContent = `(failed to load root: HTTP ${response.status})`;
      return;
    }
    const data = await response.json();
    el.rootBasename.textContent = data.basename;
    el.rootPath.textContent = data.absolutePath;
  } catch (err) {
    el.rootBasename.textContent = "(failed to load root)";
  }
}

async function loadTree() {
  try {
    const response = await fetch(apiUrl("/api/tree"));
    if (!response.ok) {
      el.treeRoot.textContent = `Failed to load the file tree (HTTP ${response.status}).`;
      return;
    }
    const entries = await response.json();
    state.entries = entries;
    buildTree(entries);
    renderTree();
  } catch (err) {
    el.treeRoot.textContent = "Failed to load the file tree.";
  }
}

// ---- Tree construction ----

function buildTree(entries) {
  const root = {
    path: "",
    name: "",
    isDir: true,
    likelySecret: false,
    children: new Map(),
  };
  const nodesByPath = new Map([["", root]]);

  for (const entry of entries) {
    ensureNode(nodesByPath, entry.path, entry.is_dir, entry.likely_secret);
  }

  computeFileDescendants(root);

  state.rootNode = root;
  state.nodesByPath = nodesByPath;

  // Default to the top level expanded so the tree isn't empty-looking on
  // first load; deeper directories start collapsed.
  state.expandedDirs = new Set();
  for (const child of root.children.values()) {
    if (child.isDir) state.expandedDirs.add(child.path);
  }
}

export function ensureNode(nodesByPath, path, isDir, likelySecret) {
  const existing = nodesByPath.get(path);
  if (existing) {
    existing.isDir = isDir;
    existing.likelySecret = likelySecret;
    return existing;
  }

  const segments = path.split("/");
  const name = segments[segments.length - 1];
  const parentPath = segments.slice(0, -1).join("/");
  const parent =
    nodesByPath.get(parentPath) || ensureNode(nodesByPath, parentPath, true, false);

  const node = {
    path,
    name,
    isDir,
    likelySecret,
    children: new Map(),
  };
  parent.children.set(name, node);
  nodesByPath.set(path, node);
  return node;
}

/** Precomputes, per directory node, the flat list of file paths beneath
 * it, so checkbox state checks don't re-walk the tree on every render. */
export function computeFileDescendants(node) {
  if (!node.isDir) {
    node.fileDescendants = [node.path];
    return node.fileDescendants;
  }
  const files = [];
  for (const child of node.children.values()) {
    files.push(...computeFileDescendants(child));
  }
  node.fileDescendants = files;
  return files;
}

export function sortedChildren(node) {
  return Array.from(node.children.values()).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ---- Tree rendering ----

function renderTree() {
  el.treeRoot.innerHTML = "";
  if (!state.rootNode) return;

  const rootList = document.createElement("ul");
  rootList.className = "tree-list tree-list-root";
  for (const child of sortedChildren(state.rootNode)) {
    rootList.appendChild(renderNode(child));
  }
  el.treeRoot.appendChild(rootList);
  applySearchFilter();
}

/** Given a directory node's file descendants and the set of currently
 * checked paths, returns the checkbox `checked`/`indeterminate` pair that
 * represents that directory's aggregate state. Pulled out of `renderNode` so
 * the decision table (0 total, 0 checked, partial, all) can be tested
 * without a DOM. */
export function describeCheckboxState(fileDescendants, checkedSet) {
  const total = fileDescendants.length;
  const checkedCount = fileDescendants.filter((p) => checkedSet.has(p)).length;
  return {
    checked: total > 0 && checkedCount === total,
    indeterminate: checkedCount > 0 && checkedCount < total,
  };
}

function renderNode(node) {
  const li = document.createElement("li");
  li.className = "tree-node";
  li.dataset.path = node.path;

  const row = document.createElement("div");
  row.className = "tree-row";

  if (node.isDir) {
    const expanded = state.expandedDirs.has(node.path);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tree-toggle";
    toggle.textContent = expanded ? "▾" : "▸";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", expanded ? "Collapse directory" : "Expand directory");
    toggle.addEventListener("click", () => toggleDir(node.path));
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "tree-spacer";
    row.appendChild(spacer);
  }

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "tree-checkbox";
  if (node.isDir) {
    const { checked, indeterminate } = describeCheckboxState(node.fileDescendants, state.checked);
    checkbox.checked = checked;
    checkbox.indeterminate = indeterminate;
  } else {
    checkbox.checked = state.checked.has(node.path);
  }
  checkbox.addEventListener("change", () => {
    handleCheckboxChange(node, checkbox.checked);
  });

  const label = document.createElement("label");
  label.className = "tree-label";
  label.appendChild(checkbox);

  const nameSpan = document.createElement("span");
  nameSpan.className = "tree-name";
  nameSpan.textContent = node.name;
  nameSpan.title = node.name;
  label.appendChild(nameSpan);

  row.appendChild(label);

  if (!node.isDir && node.likelySecret) {
    const badge = document.createElement("span");
    badge.className = "secret-badge";
    badge.textContent = "⚠ secret?";
    badge.title = "This file's name looks like it may contain secrets.";
    row.appendChild(badge);
  }

  li.appendChild(row);

  if (node.isDir) {
    const childList = document.createElement("ul");
    childList.className = "tree-list";
    if (!state.expandedDirs.has(node.path)) {
      childList.classList.add("collapsed");
    }
    for (const child of sortedChildren(node)) {
      childList.appendChild(renderNode(child));
    }
    li.appendChild(childList);
  }

  return li;
}

function toggleDir(path) {
  if (state.expandedDirs.has(path)) {
    state.expandedDirs.delete(path);
  } else {
    state.expandedDirs.add(path);
  }
  renderTree();
}

function handleCheckboxChange(node, isChecked) {
  const files = node.isDir ? node.fileDescendants : [node.path];
  if (isChecked) {
    for (const path of files) state.checked.add(path);
  } else {
    for (const path of files) state.checked.delete(path);
  }
  renderTree();
  syncOpenFilesWithChecked();
}

// ---- Presets ----

function wirePresetButtons() {
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });
}

function applyPreset(preset) {
  const allFiles = state.entries.filter((e) => !e.is_dir).map((e) => e.path);

  if (preset === "all-text") {
    state.checked = new Set(allFiles);
  } else if (preset === "source") {
    state.checked = new Set(allFiles.filter(isSourceFile));
  } else if (preset === "docs") {
    state.checked = new Set(allFiles.filter(isDocFile));
  } else if (preset === "clear") {
    state.checked = new Set();
  }

  renderTree();
  syncOpenFilesWithChecked();
}

export function extensionOf(path) {
  const name = path.split("/").pop();
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return name.slice(dotIndex + 1).toLowerCase();
}

export function isSourceFile(path) {
  return SOURCE_EXTENSIONS.has(extensionOf(path));
}

export function isDocFile(path) {
  // Known quirk (issue discovery #4): this function only looks at the
  // path/name shape, so it cannot tell a file from a directory. A directory
  // literally named "docs" (or "README" with no extension) returns true
  // here just like a real doc file would. Known, not fixed here; left for
  // review to decide whether callers should filter to files first.
  if (DOC_EXTENSIONS.has(extensionOf(path))) return true;
  const name = path.split("/").pop();
  if (name.startsWith("README")) return true;
  if (path === "docs" || path.startsWith("docs/")) return true;
  return false;
}

// ---- Stable references (format/parse) ----
//
// Reference syntax (issue #5): "@file:<path>", "@dir:<path>", and
// "@lines:<path>#L<start>" or "@lines:<path>#L<start>-L<end>" (the same
// "#L42-L57" convention GitHub's own blob view uses). This is the one
// canonical string form shared by the UI display, the URL fragment, and (in
// a later issue) copied text, so format/parse are plain, DOM-free functions
// that can be reused from all three places.

const LINES_RANGE_PATTERN = /^L(\d+)(?:-L(\d+))?$/;

export function formatFileRef(path) {
  return `@file:${path}`;
}

export function formatDirRef(path) {
  return `@dir:${path}`;
}

/** Formats a "@lines:<path>#L<start>" or "@lines:<path>#L<start>-L<end>"
 * reference, normalizing `start`/`end` to `min`/`max` regardless of call
 * order (mirroring `parseRef`'s leniency about swapped numbers) and
 * clamping both to a minimum of 1. The clamp keeps this function's output
 * always parseable by `parseRef` -- which rejects any line number below 1
 * -- even if a caller passes 0 or a negative number in by mistake, since
 * callers (e.g. a future copy-to-clipboard feature) shouldn't have to
 * separately validate line numbers before formatting them. */
export function formatLinesRef(path, start, end) {
  const rangeEnd = end ?? start;
  const lo = Math.max(1, Math.min(start, rangeEnd));
  const hi = Math.max(1, Math.max(start, rangeEnd));
  return lo === hi ? `@lines:${path}#L${lo}` : `@lines:${path}#L${lo}-L${hi}`;
}

/** Parses one reference string into `{ kind: "file", path }`,
 * `{ kind: "dir", path }`, or `{ kind: "lines", path, start, end }`, or
 * returns `null` if `refString` isn't a well-formed reference of any known
 * kind (unrecognized prefix, empty path, malformed/out-of-range line
 * numbers). The inverse of `formatFileRef`/`formatDirRef`/`formatLinesRef`
 * for well-formed input, but deliberately lenient about which of the two
 * line numbers came first: "@lines:p#L57-L42" is accepted and normalized to
 * start=42/end=57, since a hand-edited URL fragment shouldn't silently fail
 * to navigate just because the two numbers were swapped.
 *
 * A path that itself contains "#" (e.g. "notes#1.md") still round-trips:
 * the *last* "#" in the string is treated as the start of the line-range
 * suffix, not the first, since the range suffix is always what
 * `formatLinesRef` appended most recently. This isn't a fully general
 * solution -- a path containing the literal substring "#L5" right before
 * its real range suffix could still be misread -- but it correctly handles
 * every practical case of a "#" occurring earlier in the path. */
export function parseRef(refString) {
  if (typeof refString !== "string") return null;

  if (refString.startsWith("@file:")) {
    const path = refString.slice("@file:".length);
    return path === "" ? null : { kind: "file", path };
  }

  if (refString.startsWith("@dir:")) {
    const path = refString.slice("@dir:".length);
    return path === "" ? null : { kind: "dir", path };
  }

  if (refString.startsWith("@lines:")) {
    const rest = refString.slice("@lines:".length);
    const hashIndex = rest.lastIndexOf("#");
    if (hashIndex === -1) return null;

    const path = rest.slice(0, hashIndex);
    const rangePart = rest.slice(hashIndex + 1);
    if (path === "") return null;

    const match = LINES_RANGE_PATTERN.exec(rangePart);
    if (!match) return null;

    const first = Number.parseInt(match[1], 10);
    const second = match[2] !== undefined ? Number.parseInt(match[2], 10) : first;
    if (first < 1 || second < 1) return null;

    return { kind: "lines", path, start: Math.min(first, second), end: Math.max(first, second) };
  }

  return null;
}

/** URL-fragment encoding for a reference string: `encodeURIComponent` the
 * whole thing so path characters, "@", "#", and non-ASCII text all survive
 * being placed after the page's own "#" in `location.hash`. */
export function hashFragmentFromRef(refString) {
  return encodeURIComponent(refString);
}

/** Inverse of `hashFragmentFromRef`, tolerant of malformed percent-encoding
 * (returns `null` instead of throwing) since `fragment` may come straight
 * from `location.hash`, which a user can edit by hand or navigate to via a
 * stale/foreign link. `fragment` must already have its leading "#" stripped
 * (i.e. pass `location.hash.slice(1)`, not `location.hash` itself). */
export function refFromHashFragment(fragment) {
  if (!fragment) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(fragment);
  } catch (err) {
    return null;
  }
  return parseRef(decoded);
}

// ---- Search filter ----

function wireSearchInput() {
  el.searchInput.addEventListener("input", applySearchFilter);
}

/** Computes, for every node in the tree rooted at `rootNode`, whether the
 * node's own path matches `query` and whether any of its descendants do, in
 * a single pass over the tree structure. Pulled out of `applySearchFilter`
 * so the match decision doesn't have to re-walk the rendered DOM's
 * descendants from every single node (an O(n^2) `querySelectorAll` call per
 * node), and so it can be tested without a DOM. `query` should already be
 * trimmed and lower-cased; an empty query is the caller's responsibility to
 * short-circuit (this function doesn't special-case it). */
export function computeSearchMatches(rootNode, query) {
  const matchesByPath = new Map();

  function visit(node) {
    const selfMatches = node.path !== "" && node.path.toLowerCase().includes(query);
    let descendantMatches = false;
    for (const child of node.children.values()) {
      visit(child);
      const childMatch = matchesByPath.get(child.path);
      if (childMatch.selfMatches || childMatch.descendantMatches) {
        descendantMatches = true;
      }
    }
    matchesByPath.set(node.path, { selfMatches, descendantMatches });
  }

  visit(rootNode);
  return matchesByPath;
}

function applySearchFilter() {
  const query = el.searchInput.value.trim().toLowerCase();
  const allNodes = el.treeRoot.querySelectorAll(".tree-node");

  if (query === "") {
    allNodes.forEach((li) => {
      li.classList.remove("filtered-out");
      const childList = li.querySelector(":scope > .tree-list");
      if (childList) childList.classList.remove("search-open");
    });
    return;
  }

  const matchesByPath = state.rootNode ? computeSearchMatches(state.rootNode, query) : new Map();

  allNodes.forEach((li) => {
    const path = li.dataset.path || "";
    const match = matchesByPath.get(path) || { selfMatches: false, descendantMatches: false };

    li.classList.toggle("filtered-out", !match.selfMatches && !match.descendantMatches);

    const childList = li.querySelector(":scope > .tree-list");
    if (childList) childList.classList.toggle("search-open", match.descendantMatches);
  });
}

// ---- Right pane (open files) ----

async function syncOpenFilesWithChecked() {
  const checkedPaths = state.checked;

  for (const path of Array.from(state.openFiles)) {
    if (!checkedPaths.has(path)) {
      closeFile(path);
    }
  }

  const toOpen = Array.from(checkedPaths)
    .filter((path) => !state.openFiles.includes(path))
    .sort();

  for (const path of toOpen) {
    await openFile(path);
  }
}

/** Computes the next open-files list after opening `path`: add `path` if not
 * already present, then re-sort by path so the right pane always shows files
 * in tree (path) order, regardless of the order files were checked in. Pulled
 * out of `openFile` so this pure list logic can be tested without touching
 * the network or DOM. */
export function nextOpenFilesList(currentList, path) {
  const list = currentList.includes(path) ? [...currentList] : [...currentList, path];
  list.sort();
  return list;
}

async function openFile(path) {
  state.openFiles = nextOpenFilesList(state.openFiles, path);
  addToRecent(path);
  renderRecentList();
  renderFilePanels();

  try {
    const response = await fetch(apiUrl(`/api/file?path=${encodeURIComponent(path)}`));
    if (!response.ok) {
      state.fileContentCache.set(path, `(failed to load: HTTP ${response.status})`);
    } else {
      const text = await response.text();
      state.fileContentCache.set(path, text);
    }
  } catch (err) {
    state.fileContentCache.set(path, `(failed to load: ${err})`);
  }

  renderFilePanels();
}

function closeFile(path) {
  state.openFiles = state.openFiles.filter((p) => p !== path);
  state.fileContentCache.delete(path);
  state.collapsedPanels.delete(path);
  state.lineSelections.delete(path);
  renderFilePanels();
}

function renderFilePanels() {
  el.filePanels.innerHTML = "";
  el.contentEmptyHint.style.display = state.openFiles.length === 0 ? "" : "none";

  for (const path of state.openFiles) {
    el.filePanels.appendChild(buildFilePanel(path));
  }
}

function buildFilePanel(path) {
  const collapsed = state.collapsedPanels.has(path);

  const article = document.createElement("article");
  article.className = "file-panel";
  article.dataset.path = path;

  const header = document.createElement("header");
  header.className = "file-panel-header";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "file-panel-toggle";
  toggle.textContent = collapsed ? "▸" : "▾";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", collapsed ? "Expand file panel" : "Collapse file panel");
  toggle.addEventListener("click", () => {
    if (state.collapsedPanels.has(path)) {
      state.collapsedPanels.delete(path);
    } else {
      state.collapsedPanels.add(path);
    }
    renderFilePanels();
  });
  header.appendChild(toggle);

  const titleWrap = document.createElement("div");
  titleWrap.className = "file-panel-title-wrap";

  const heading = document.createElement("h2");
  heading.className = "file-panel-title";
  heading.textContent = path;
  titleWrap.appendChild(heading);

  const fileRef = document.createElement("span");
  fileRef.className = "file-panel-ref";
  fileRef.textContent = formatFileRef(path);
  titleWrap.appendChild(fileRef);

  header.appendChild(titleWrap);

  const linesRef = document.createElement("span");
  linesRef.className = "file-panel-lines-ref";
  header.appendChild(linesRef);

  article.appendChild(header);

  if (!collapsed) {
    const pre = document.createElement("pre");
    pre.className = "file-panel-body";
    const code = document.createElement("code");
    code.className = "file-panel-code";

    if (!state.fileContentCache.has(path)) {
      code.textContent = "Loading…";
    } else {
      buildCodeLines(code, path, state.fileContentCache.get(path));
    }

    pre.appendChild(code);
    article.appendChild(pre);
  }

  updateLineSelectionDom(path, article);

  return article;
}

/** Splits `content` into `.code-line` rows, each holding a `user-select:
 * none` line-number cell (so dragging across code to copy it never picks up
 * the numbers) and the line's own text in a separate cell. A trailing empty
 * element from a final "\n" is dropped so the displayed line count matches
 * what an editor would show, not an off-by-one over-count. */
function buildCodeLines(code, path, content) {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  code.style.setProperty("--line-number-width", `${String(lines.length).length}ch`);

  lines.forEach((lineText, index) => {
    const lineNumber = index + 1;

    const lineRow = document.createElement("span");
    lineRow.className = "code-line";
    lineRow.dataset.lineNumber = String(lineNumber);

    const numberCell = document.createElement("span");
    numberCell.className = "line-number";
    numberCell.textContent = String(lineNumber);
    numberCell.addEventListener("click", (event) => {
      handleLineClick(path, lineNumber, event.shiftKey);
    });
    lineRow.appendChild(numberCell);

    const contentCell = document.createElement("span");
    contentCell.className = "line-content";
    contentCell.textContent = lineText;
    lineRow.appendChild(contentCell);

    code.appendChild(lineRow);
  });
}

/** Finds the open file panel `<article>` for `path`, or `null` if that file
 * isn't currently open. Iterates `el.filePanels`'s direct children instead
 * of a `querySelector` attribute match, since a `path` can contain
 * characters (quotes, etc.) that would need escaping in a CSS selector. */
function findFilePanelElement(path) {
  for (const child of el.filePanels.children) {
    if (child.dataset.path === path) return child;
  }
  return null;
}

// ---- Line click / Shift-click range selection ----

/** Computes the next line-selection state for a file, given the current
 * selection (or undefined if none yet), the clicked line, and whether Shift
 * was held. A plain click always starts a fresh single-line selection at
 * that line (this also covers Shift-click with no prior anchor: there is
 * nothing to extend from, so it falls back to a single-line selection).
 * Shift-click extends from the existing anchor to the clicked line,
 * regardless of click order (always normalized to min/max). */
export function nextLineSelection(current, lineNumber, shiftKey) {
  if (shiftKey && current) {
    return { anchor: current.anchor, start: Math.min(current.anchor, lineNumber), end: Math.max(current.anchor, lineNumber) };
  }
  return { anchor: lineNumber, start: lineNumber, end: lineNumber };
}

function handleLineClick(path, lineNumber, shiftKey) {
  const current = state.lineSelections.get(path);
  const next = nextLineSelection(current, lineNumber, shiftKey);
  setLineSelection(path, next.anchor, next.start, next.end);
}

/** Records the selection for `path` (`anchor` is the plain-click line that
 * Shift-click ranges are measured from; the highlighted range is always
 * `min`/`max` of the two endpoints regardless of click order), reflects it
 * in that file panel's DOM, and -- unless `writeHash` is `false` (used when
 * a selection is being applied *from* an incoming hash, to avoid rewriting
 * the same navigation back onto itself) -- updates the URL to match.
 *
 * Uses `history.replaceState` (via `writeRefToHash`) rather than assigning
 * `window.location.hash` directly: a plain hash assignment fires a
 * `hashchange` event, which would re-enter `handleHashNavigation` ->
 * `revealFilePanel` for every single line click, forcing an unwanted
 * `scrollIntoView` + `flashHighlight` on every click (a self-triggered
 * navigation loop). `replaceState` updates
 * `location.hash`/the address bar without firing `hashchange`, so an
 * internal click never re-triggers its own navigation handler. It also
 * doesn't push a new history entry, which is desirable here anyway --
 * clicking through lines shouldn't pile up "back" entries -- while an
 * incoming hash from a bookmark/typed URL, or the browser's own back/
 * forward navigation, still fires `hashchange` normally and is handled by
 * `wireHashNavigation` as before. */
function setLineSelection(path, anchor, endpointA, endpointB, writeHash = true) {
  const start = Math.min(endpointA, endpointB);
  const end = Math.max(endpointA, endpointB);
  state.lineSelections.set(path, { anchor, start, end });
  updateLineSelectionDom(path);

  if (writeHash) {
    writeRefToHash(formatLinesRef(path, start, end));
  }
}

/** Writes `refString` to the URL as a percent-encoded fragment via
 * `window.history.replaceState`, without pushing a new history entry and
 * without firing `hashchange` (see `setLineSelection`'s doc comment for why
 * that matters). Pulled out into its own exported function so this one
 * `window`-touching statement can be unit-tested in isolation -- by
 * stubbing `window.history.replaceState` -- without needing the DOM that
 * the rest of `setLineSelection` (via `updateLineSelectionDom`) depends on. */
export function writeRefToHash(refString) {
  window.history.replaceState(null, "", "#" + hashFragmentFromRef(refString));
}

/** Applies the current `state.lineSelections` entry for `path` (if any) to
 * that file's already-rendered panel: toggles `.line-selected` on the
 * matching `.code-line` rows and updates the panel's `@lines:...` display.
 * Takes an optional already-known `panel` element (used from `buildFilePanel`,
 * where the panel isn't attached to `el.filePanels` yet) and otherwise looks
 * it up via `findFilePanelElement`. A no-op if the panel can't be found
 * (e.g. the file isn't open). */
function updateLineSelectionDom(path, panel = findFilePanelElement(path)) {
  if (!panel) return;

  const selection = state.lineSelections.get(path);

  panel.querySelectorAll(".code-line").forEach((row) => {
    const lineNumber = Number(row.dataset.lineNumber);
    const selected = Boolean(selection && lineNumber >= selection.start && lineNumber <= selection.end);
    row.classList.toggle("line-selected", selected);
  });

  const linesRefEl = panel.querySelector(".file-panel-lines-ref");
  if (!linesRefEl) return;
  linesRefEl.textContent = selection ? formatLinesRef(path, selection.start, selection.end) : "";
  linesRefEl.style.display = selection ? "" : "none";
}

// ---- URL fragment navigation ----

function wireHashNavigation() {
  window.addEventListener("hashchange", handleHashNavigation);
}

function handleHashNavigation() {
  const fragment = window.location.hash.slice(1);
  if (!fragment) return;

  const ref = refFromHashFragment(fragment);
  if (!ref) return;

  if (ref.kind === "dir") {
    revealDirNode(ref.path);
  } else if (ref.kind === "file") {
    revealFilePanel(ref.path, null);
  } else if (ref.kind === "lines") {
    revealFilePanel(ref.path, ref);
  }
}

/** Scrolls to and highlights the open file panel for `path`, applying
 * `range`'s line selection first if given. A no-op if `path` isn't currently
 * open in the right pane -- auto-opening a file from a URL fragment is out
 * of scope for this issue. Expands a collapsed panel first, since otherwise
 * there would be no code rows to highlight or scroll to. */
function revealFilePanel(path, range) {
  if (!state.openFiles.includes(path)) return;

  if (state.collapsedPanels.has(path)) {
    state.collapsedPanels.delete(path);
    renderFilePanels();
  }

  if (range) {
    // `writeHash: false` here: this selection is being *applied from* the
    // hash we just navigated to, so writing it back would be a redundant
    // no-op at best and a feedback loop at worst.
    setLineSelection(path, range.end, range.start, range.end, false);
  }

  const panel = findFilePanelElement(path);
  if (!panel) return;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  flashHighlight(panel);
}

/** Finds the tree `<li class="tree-node">` for `path`, or `null` if no such
 * node exists in the currently loaded tree. Same rationale as
 * `findFilePanelElement` for iterating instead of using a CSS attribute
 * selector. */
function findTreeNodeElement(path) {
  for (const li of el.treeRoot.querySelectorAll(".tree-node")) {
    if (li.dataset.path === path) return li;
  }
  return null;
}

/** Expands every ancestor directory of `path` (not `path` itself) so an
 * "@dir:" reference's target is guaranteed visible in the rendered tree,
 * then scrolls to and highlights it. A no-op if `path` isn't a node in the
 * currently loaded tree at all, or if it names a file rather than a
 * directory (an "@dir:" reference to a file path is out of contract, not a
 * fallback for revealing that file's tree row). */
function revealDirNode(path) {
  if (!state.nodesByPath.get(path)?.isDir) return;

  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    state.expandedDirs.add(segments.slice(0, i).join("/"));
  }
  renderTree();

  const node = findTreeNodeElement(path);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  flashHighlight(node);
}

/** Adds a transient `.nav-flash` highlight class to `element`, removing it
 * again after `NAV_FLASH_MS`, so a URL-fragment jump has a visible "you are
 * here" cue that fades rather than a highlight that lingers forever. */
function flashHighlight(element) {
  element.classList.add("nav-flash");
  window.setTimeout(() => {
    element.classList.remove("nav-flash");
  }, NAV_FLASH_MS);
}

// ---- Recently opened files (localStorage) ----

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "string");
  } catch (err) {
    return [];
  }
}

function saveRecent(list) {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    // localStorage may be unavailable (private browsing, quota exceeded);
    // recent history is a convenience, so failing silently is acceptable.
  }
}

/** Computes the next recent-files list after opening `path`: dedupe any
 * existing occurrence, move `path` to the front, then cap at `limit`. Pulled
 * out of `addToRecent` so this pure list logic can be tested without
 * touching localStorage. */
export function nextRecentList(currentList, path, limit) {
  const list = currentList.filter((p) => p !== path);
  list.unshift(path);
  if (list.length > limit) return list.slice(0, limit);
  return list;
}

function addToRecent(path) {
  const list = nextRecentList(loadRecent(), path, RECENT_LIMIT);
  saveRecent(list);
}

function removeFromRecent(path) {
  saveRecent(loadRecent().filter((p) => p !== path));
  renderRecentList();
}

function clearRecent() {
  saveRecent([]);
  renderRecentList();
}

function wireRecentClear() {
  el.recentClear.addEventListener("click", clearRecent);
}

function renderRecentList() {
  const list = loadRecent();
  el.recentList.innerHTML = "";

  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "recent-empty";
    li.textContent = "No recently opened files yet.";
    el.recentList.appendChild(li);
    return;
  }

  for (const path of list) {
    const li = document.createElement("li");
    li.className = "recent-item";

    const reopenButton = document.createElement("button");
    reopenButton.type = "button";
    reopenButton.className = "recent-reopen";
    reopenButton.textContent = path;
    reopenButton.title = path;
    reopenButton.addEventListener("click", () => reopenFromRecent(path));
    li.appendChild(reopenButton);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "recent-remove";
    removeButton.textContent = "✕";
    removeButton.setAttribute("aria-label", `Remove ${path} from recently opened`);
    removeButton.addEventListener("click", () => removeFromRecent(path));
    li.appendChild(removeButton);

    el.recentList.appendChild(li);
  }
}

function reopenFromRecent(path) {
  if (!state.nodesByPath.has(path)) {
    // The file may no longer exist in the current tree (deleted, moved,
    // now gitignored); there is nothing to check or open.
    return;
  }
  state.checked.add(path);
  renderTree();
  syncOpenFilesWithChecked();
}

// ---- Explorer pane resizer ----

const RESIZE_KEYBOARD_STEP = 20;

function wireResizer() {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  el.resizer.addEventListener("mousedown", (event) => {
    dragging = true;
    startX = event.clientX;
    startWidth = el.explorerPane.getBoundingClientRect().width;
    document.body.classList.add("resizing");
    event.preventDefault();
  });

  window.addEventListener("mousemove", (event) => {
    if (!dragging) return;
    const delta = event.clientX - startX;
    const newWidth = clamp(startWidth + delta, MIN_EXPLORER_WIDTH, MAX_EXPLORER_WIDTH);
    el.explorerPane.style.width = `${newWidth}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
  });

  el.resizer.addEventListener("keydown", (event) => {
    let delta = 0;
    if (event.key === "ArrowLeft") {
      delta = -RESIZE_KEYBOARD_STEP;
    } else if (event.key === "ArrowRight") {
      delta = RESIZE_KEYBOARD_STEP;
    } else {
      return;
    }

    const currentWidth = el.explorerPane.getBoundingClientRect().width;
    const newWidth = clamp(currentWidth + delta, MIN_EXPLORER_WIDTH, MAX_EXPLORER_WIDTH);
    el.explorerPane.style.width = `${newWidth}px`;
    event.preventDefault();
  });
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

if (typeof document !== "undefined") {
  el = {
    rootBasename: document.getElementById("root-basename"),
    rootPath: document.getElementById("root-path"),
    treeRoot: document.getElementById("tree-root"),
    searchInput: document.getElementById("search-input"),
    recentList: document.getElementById("recent-list"),
    recentClear: document.getElementById("recent-clear"),
    filePanels: document.getElementById("file-panels"),
    contentEmptyHint: document.getElementById("content-empty-hint"),
    explorerPane: document.getElementById("explorer-pane"),
    resizer: document.getElementById("resizer"),
  };

  init();
}
