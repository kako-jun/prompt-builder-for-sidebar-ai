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
};

let el = {};

async function init() {
  wirePresetButtons();
  wireSearchInput();
  wireRecentClear();
  wireResizer();
  renderRecentList();
  await Promise.all([loadRoot(), loadTree()]);
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

  const heading = document.createElement("h2");
  heading.className = "file-panel-title";
  heading.textContent = path;
  header.appendChild(heading);

  article.appendChild(header);

  if (!collapsed) {
    const pre = document.createElement("pre");
    pre.className = "file-panel-body";
    const code = document.createElement("code");
    code.textContent = state.fileContentCache.has(path)
      ? state.fileContentCache.get(path)
      : "Loading…";
    pre.appendChild(code);
    article.appendChild(pre);
  }

  return article;
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
