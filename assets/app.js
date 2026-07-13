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

// Issue #28: whether the user has dismissed the security notice, persisted
// the same way as the locale/recent-files choices (best-effort localStorage,
// guarded so a private-browsing/non-browser context never throws).
const SECURITY_NOTICE_STORAGE_KEY = "pbsa-security-notice-dismissed";

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

// ---- Internationalization (i18n) ----
//
// English is the source and fallback; Japanese is the one switchable
// alternative (issue #22). A single active locale drives both the UI chrome
// and the generated prompt text. `MESSAGES` is the single source of truth for
// every user-visible string in either language; `tr(locale, key, params)` is
// the pure lookup (explicit locale, English fallback) used by the DOM-free
// prompt/stats builders so their output is deterministic per-locale and stays
// testable without a browser, and `t(key, params)` is the UI-facing wrapper
// that reads whatever locale is currently active.

const LOCALE_STORAGE_KEY = "pbsa-locale";
const SUPPORTED_LOCALES = ["en", "ja"];

const MESSAGES = {
  en: {
    // Generated prompt -- goal instructions
    "goal.locate.instruction": "Locate the code and functions most relevant to the request below.",
    "goal.explain.instruction": "Explain what this code does and how it works.",
    "goal.investigate-bug.instruction":
      "Investigate the described bug (or its impact), including its likely root cause.",
    "goal.review.instruction": "Review this code's design and/or security, and list any concerns.",
    "goal.extract-tests.instruction":
      "Extract or propose test cases that cover this code's behavior.",
    "goal.refactor.instruction":
      "Suggest refactoring opportunities here and explain why each would help.",
    "goal.plan.instruction": "Produce an implementation plan for the request below.",

    // Generated prompt -- output instructions
    "output.concise.instruction": "Respond with a concise answer.",
    "output.report.instruction": "Respond with a structured investigation report.",
    "output.issue.instruction":
      "Respond with a GitHub issue, ready to file, with a clear title and body.",
    "output.instructions.instruction":
      "Respond with step-by-step instructions for an implementation agent.",
    "output.checklist.instruction": "Respond with a checklist.",
    "output.diff.instruction": "Respond with a unified diff.",
    "output.file.instruction":
      "Generate the response as a downloadable file named {name}.",

    // Generated prompt -- target phrases
    "target.checked.phrase": "the checked files: {refs}",
    "target.checked.empty":
      "the checked files (none are currently checked -- check some files in the explorer first)",
    "target.lines.phrase": "the selected line range: {refs}",
    "target.lines.phrasePlural": "the selected line ranges: {refs}",
    "target.lines.empty":
      "the selected line range (no lines are currently selected -- click a line number in an open file first)",
    "target.diff.phrase": "the current Git diff of this project",
    "target.page.phrase": "the whole page (everything currently visible in this browser tab)",

    // Generated prompt -- assembled sentences
    "prompt.targetLine": "Target: {target}.",
    "prompt.additionalInstructions": "Additional instructions:\n{text}",
    "prompt.referenceNote":
      "When referring to a specific location in the code, use the stable references shown on the page (@file:..., @dir:..., @lines:...) so it can be traced back precisely.",

    // Generated prompt -- context section
    "context.heading": "## Context",
    "context.gitDiffHeading": "### Git diff",
    "context.diff.pageNote":
      '(Git diff content is never shown on the page itself, so "Page context only" can\'t include it here. Switch context mode to "Referenced excerpts" or "Full selected files" to embed the diff.)',
    // Git-diff target status lines embedded in the generated prompt (issue #22:
    // these are user-visible prose, so they live in the catalog rather than
    // being hardcoded in `gatherDiffEntries`). `diff.status.clean` doubles as
    // `buildPromptContextSection`'s defensive "no entry at all" fallback, which
    // is why there is no separate generic "no diff" message.
    "diff.status.notRepo": "(This directory is not a Git repository, so there is no diff to show.)",
    "diff.status.clean": "(No local changes: the working tree is clean.)",
    "diff.status.loadFailed": "(failed to load the Git diff: {detail})",
    "context.excerpts.none":
      '(No line range is currently selected, so no excerpt could be embedded here. Select one first, or switch context mode to "Page context only".)',
    "context.full.none":
      '(No files are currently checked, so no content could be embedded here. Check some files first, or switch context mode to "Page context only".)',

    // Selection size statistics
    "stats.none": "No files selected.",
    "stats.oneFile": "1 file selected",
    "stats.manyFiles": "{count} files selected",
    "stats.pending": " ({count} still loading)",
    "stats.base": "{files}{pending} · {chars} characters · ~{tokens} tokens (rough estimate)",
    "stats.large": " · ⚠ large selection",

    // Composer -- goal option labels
    "goal.locate.label": "Find relevant code",
    "goal.explain.label": "Explain code",
    "goal.investigate-bug.label": "Investigate a bug or its impact",
    "goal.review.label": "Review design or security",
    "goal.extract-tests.label": "Extract test cases",
    "goal.refactor.label": "Suggest refactoring",
    "goal.plan.label": "Plan implementation",

    // Composer -- target option labels
    "target.page.label": "Whole page",
    "target.checked.label": "Checked files",
    "target.lines.label": "Selected lines",
    "target.diff.label": "Git diff",

    // Composer -- output option labels
    "output.concise.label": "Concise answer",
    "output.report.label": "Investigation report",
    "output.issue.label": "GitHub issue",
    "output.instructions.label": "Implementation instructions",
    "output.checklist.label": "Checklist",
    "output.diff.label": "Unified diff",
    "output.file.label": "Downloadable file",

    // Composer -- context-mode option labels
    "contextMode.page.label": "Page context only",
    "contextMode.excerpts.label": "Referenced excerpts",
    "contextMode.full.label": "Full selected files",

    // Static chrome
    // Issue #28: rewritten to name the actual risk (untrusted file content;
    // an external, uncontrolled AI on the receiving end of a paste) instead
    // of reading as "this app is dangerous". See the HTML comment near
    // #security-notice and THREAT_MODEL.md for the full rationale.
    "security.notice":
      "⚠ What you copy goes to the third-party AI you picked. Treat the files you open as untrusted input, too -- their contents can include text that steers the AI. What you share is your call.",
    "security.dismiss": "Dismiss this notice",
    "security.collapsedLabel": "Safety notice",
    "locale.label": "Language",
    "root.loading": "Loading…",
    "root.loadFailed": "(failed to load root)",
    "root.loadFailedHttp": "(failed to load root: HTTP {status})",
    "preset.allText": "All text files",
    "preset.sourceOnly": "Source only",
    "preset.docsOnly": "Docs only",
    "preset.clearSelection": "Clear selection",
    "preset.groupTitle": "Quick select",
    "search.label": "Filter files by path",
    "search.placeholder": "Filter by path…",
    "recent.title": "Recently opened",
    "recent.clear": "Clear history",
    "recent.empty": "No recently opened files yet.",
    "recent.removeAria": "Remove {path} from recently opened",
    "tree.truncationWarning":
      "⚠ This project has more files than can be shown at once; the list below is incomplete.",
    "tree.explorerLabel": "File explorer",
    "tree.loadFailed": "Failed to load the file tree.",
    "tree.loadFailedHttp": "Failed to load the file tree (HTTP {status}).",
    "tree.expandDir": "Expand directory",
    "tree.collapseDir": "Collapse directory",
    "tree.dirCopyTitle": "Copy all files in this directory (Markdown)",
    "tree.dirCopyAria": "Copy all files under {path}",
    "tree.rootName": "the project root",
    "tree.secretBadge": "⚠ secret?",
    "tree.secretTitle": "This file's name looks like it may contain secrets.",
    "resizer.label": "Resize explorer pane",
    "promptComposer.ariaLabel": "Prompt composer",
    "promptComposer.title": "Prompt composer",
    "promptComposer.collapse": "Collapse prompt composer",
    "promptComposer.expand": "Expand prompt composer",
    "composer.goal": "Goal",
    "composer.target": "Target",
    "composer.output": "Output",
    "composer.filename": "Filename",
    "composer.filenamePlaceholder": "e.g. test-spec.md",
    "composer.contextMode": "Context mode",
    "composer.extra": "Additional instructions (optional)",
    "composer.generate": "Generate prompt",
    "composer.copy": "Copy prompt",
    "composer.result": "Generated prompt (editable)",
    "composer.resultPlaceholder": "Choose options above and click “Generate prompt”.",
    "content.emptyHint": "Select files in the explorer to see their contents here.",
    "filePanel.expand": "Expand file panel",
    "filePanel.collapse": "Collapse file panel",
    "file.loading": "Loading…",
    "file.loadFailed": "(failed to load: {err})",
    "file.loadFailedHttp": "(failed to load: HTTP {status})",
    "copy.copy": "Copy",
    "copy.copied": "Copied!",
    "copy.failed": "Copy failed",
    "copy.moreOptions": "More copy options",
    "menu.copyFileAs": "Copy file as {format}",
    "menu.copyReferenceOnly": "Copy reference only",
    "menu.copyReferenceAndCode": "Copy reference + code",
    "menu.copyAllCheckedAs": "Copy all checked as {format}",
    "menu.copyFileTree": "Copy file tree",
    "toolbar.oneFileOpen": "1 file open",
    "toolbar.manyFilesOpen": "{count} files open",
    "toolbar.copyAllChecked": "Copy all checked",
    "toast.copied": "Copied to clipboard.",
    "toast.copyFailed": "Copy failed: {error}",
    "toast.unknownError": "unknown error",
    "clipboard.unavailable": "Clipboard API is not available in this browser.",
  },
  ja: {
    // Generated prompt -- goal instructions
    "goal.locate.instruction": "以下の依頼に最も関連するコードと関数を特定してください。",
    "goal.explain.instruction": "このコードが何をするか、どのように動作するかを説明してください。",
    "goal.investigate-bug.instruction":
      "記載されたバグ（またはその影響）を、想定される根本原因も含めて調査してください。",
    "goal.review.instruction": "このコードの設計やセキュリティをレビューし、懸念点を挙げてください。",
    "goal.extract-tests.instruction":
      "このコードの挙動をカバーするテストケースを抽出または提案してください。",
    "goal.refactor.instruction":
      "ここでのリファクタリングの余地を提案し、それぞれがなぜ有効かを説明してください。",
    "goal.plan.instruction": "以下の依頼に対する実装計画を作成してください。",

    // Generated prompt -- output instructions
    "output.concise.instruction": "簡潔な回答で答えてください。",
    "output.report.instruction": "構造化された調査レポートで答えてください。",
    "output.issue.instruction":
      "そのまま起票できるGitHub issueを、明確なタイトルと本文付きで答えてください。",
    "output.instructions.instruction":
      "実装エージェント向けの手順を、ステップごとに答えてください。",
    "output.checklist.instruction": "チェックリストで答えてください。",
    "output.diff.instruction": "unified diffで答えてください。",
    "output.file.instruction":
      "回答を {name} という名前のダウンロード可能なファイルとして生成してください。",

    // Generated prompt -- target phrases
    "target.checked.phrase": "チェックしたファイル: {refs}",
    "target.checked.empty":
      "チェックしたファイル（現在チェックされているファイルはありません — まずエクスプローラーでファイルをチェックしてください）",
    "target.lines.phrase": "選択した行範囲: {refs}",
    "target.lines.phrasePlural": "選択した行範囲: {refs}",
    "target.lines.empty":
      "選択した行範囲（現在選択されている行はありません — まず開いているファイルの行番号をクリックしてください）",
    "target.diff.phrase": "このプロジェクトの現在のGit差分",
    "target.page.phrase": "ページ全体（このブラウザタブに現在表示されているすべて）",

    // Generated prompt -- assembled sentences
    "prompt.targetLine": "対象: {target}。",
    "prompt.additionalInstructions": "追加の指示:\n{text}",
    "prompt.referenceNote":
      "コード内の特定の箇所を参照するときは、ページに表示されている安定参照（@file:..., @dir:..., @lines:...）を使い、正確に辿れるようにしてください。",

    // Generated prompt -- context section
    "context.heading": "## コンテキスト",
    "context.gitDiffHeading": "### Git差分",
    "context.diff.pageNote":
      "（Git差分はページ自体には表示されないため、「ページのコンテキストのみ」ではここに含められません。差分を埋め込むには、コンテキストモードを「参照した抜粋」または「選択したファイル全体」に切り替えてください。）",
    "diff.status.notRepo": "（このディレクトリは Git リポジトリではないため、表示できる差分はありません。）",
    "diff.status.clean": "（ローカルの変更はありません。作業ツリーはクリーンです。）",
    "diff.status.loadFailed": "（Git 差分の取得に失敗しました: {detail}）",
    "context.excerpts.none":
      "（現在選択されている行範囲がないため、抜粋を埋め込めませんでした。まず選択するか、コンテキストモードを「ページのコンテキストのみ」に切り替えてください。）",
    "context.full.none":
      "（現在チェックされているファイルがないため、内容を埋め込めませんでした。まずファイルをチェックするか、コンテキストモードを「ページのコンテキストのみ」に切り替えてください。）",

    // Selection size statistics
    "stats.none": "ファイルが選択されていません。",
    "stats.oneFile": "1 ファイル選択中",
    "stats.manyFiles": "{count} ファイル選択中",
    "stats.pending": "（{count} 件読み込み中）",
    "stats.base": "{files}{pending} · {chars} 文字 · 約 {tokens} トークン（概算）",
    "stats.large": " · ⚠ 選択が大きすぎます",

    // Composer -- goal option labels
    "goal.locate.label": "関連コードを探す",
    "goal.explain.label": "コードを説明",
    "goal.investigate-bug.label": "バグやその影響を調査",
    "goal.review.label": "設計やセキュリティをレビュー",
    "goal.extract-tests.label": "テストケースを抽出",
    "goal.refactor.label": "リファクタリングを提案",
    "goal.plan.label": "実装計画を立てる",

    // Composer -- target option labels
    "target.page.label": "ページ全体",
    "target.checked.label": "チェックしたファイル",
    "target.lines.label": "選択した行",
    "target.diff.label": "Git差分",

    // Composer -- output option labels
    "output.concise.label": "簡潔な回答",
    "output.report.label": "調査レポート",
    "output.issue.label": "GitHub issue",
    "output.instructions.label": "実装手順",
    "output.checklist.label": "チェックリスト",
    "output.diff.label": "unified diff",
    "output.file.label": "ダウンロードファイル",

    // Composer -- context-mode option labels
    "contextMode.page.label": "ページのコンテキストのみ",
    "contextMode.excerpts.label": "参照した抜粋",
    "contextMode.full.label": "選択したファイル全体",

    // Static chrome
    // Issue #28: 実際のリスクの出どころ（信頼できない入力としてのファイル、
    // 貼り付け先の第三者AI）を名指しする文言に改訂。#security-notice 近くの
    // HTMLコメントと THREAT_MODEL.md に方針転換の経緯を記載。
    "security.notice":
      "⚠ コピーした内容は、あなたが選んだ外部のAIに渡ります。開いたファイル自体も「信頼できない入力」として扱ってください（中身にAIを誘導する文が紛れていることがあります）。何を共有するかはあなた次第です。",
    "security.dismiss": "この通知を閉じる",
    "security.collapsedLabel": "安全性の通知",
    "locale.label": "言語",
    "root.loading": "読み込み中…",
    "root.loadFailed": "（ルートの読み込みに失敗しました）",
    "root.loadFailedHttp": "（ルートの読み込みに失敗しました: HTTP {status}）",
    "preset.allText": "すべてのテキストファイル",
    "preset.sourceOnly": "ソースのみ",
    "preset.docsOnly": "ドキュメントのみ",
    "preset.clearSelection": "選択をクリア",
    "preset.groupTitle": "クイック選択",
    "search.label": "パスでファイルを絞り込む",
    "search.placeholder": "パスで絞り込み…",
    "recent.title": "最近開いたファイル",
    "recent.clear": "履歴をクリア",
    "recent.empty": "最近開いたファイルはまだありません。",
    "recent.removeAria": "{path} を最近開いたファイルから削除",
    "tree.truncationWarning":
      "⚠ このプロジェクトには一度に表示できる数を超えるファイルがあります。下の一覧は不完全です。",
    "tree.explorerLabel": "ファイルエクスプローラー",
    "tree.loadFailed": "ファイルツリーの読み込みに失敗しました。",
    "tree.loadFailedHttp": "ファイルツリーの読み込みに失敗しました（HTTP {status}）。",
    "tree.expandDir": "ディレクトリを展開",
    "tree.collapseDir": "ディレクトリを折りたたむ",
    "tree.dirCopyTitle": "このディレクトリ内の全ファイルをコピー（Markdown）",
    "tree.dirCopyAria": "{path} 以下の全ファイルをコピー",
    "tree.rootName": "プロジェクトルート",
    "tree.secretBadge": "⚠ 機密?",
    "tree.secretTitle": "このファイル名は機密情報を含む可能性があります。",
    "resizer.label": "エクスプローラーの幅を変更",
    "promptComposer.ariaLabel": "プロンプトコンポーザー",
    "promptComposer.title": "プロンプトコンポーザー",
    "promptComposer.collapse": "プロンプトコンポーザーを折りたたむ",
    "promptComposer.expand": "プロンプトコンポーザーを展開",
    "composer.goal": "目的",
    "composer.target": "対象",
    "composer.output": "出力",
    "composer.filename": "ファイル名",
    "composer.filenamePlaceholder": "例: test-spec.md",
    "composer.contextMode": "コンテキスト",
    "composer.extra": "追加の指示（任意）",
    "composer.generate": "プロンプトを生成",
    "composer.copy": "プロンプトをコピー",
    "composer.result": "生成されたプロンプト（編集可）",
    "composer.resultPlaceholder": "上のオプションを選んで「プロンプトを生成」を押してください。",
    "content.emptyHint": "エクスプローラーでファイルを選ぶと、ここに内容が表示されます。",
    "filePanel.expand": "ファイルパネルを展開",
    "filePanel.collapse": "ファイルパネルを折りたたむ",
    "file.loading": "読み込み中…",
    "file.loadFailed": "（読み込みに失敗しました: {err}）",
    "file.loadFailedHttp": "（読み込みに失敗しました: HTTP {status}）",
    "copy.copy": "コピー",
    "copy.copied": "コピーしました!",
    "copy.failed": "コピー失敗",
    "copy.moreOptions": "その他のコピー方法",
    "menu.copyFileAs": "ファイルを {format} でコピー",
    "menu.copyReferenceOnly": "参照のみコピー",
    "menu.copyReferenceAndCode": "参照 + コード をコピー",
    "menu.copyAllCheckedAs": "チェック全件を {format} でコピー",
    "menu.copyFileTree": "ファイルツリーをコピー",
    "toolbar.oneFileOpen": "1 ファイルを表示中",
    "toolbar.manyFilesOpen": "{count} ファイルを表示中",
    "toolbar.copyAllChecked": "チェック全件をコピー",
    "toast.copied": "クリップボードにコピーしました。",
    "toast.copyFailed": "コピー失敗: {error}",
    "toast.unknownError": "不明なエラー",
    "clipboard.unavailable": "このブラウザではクリップボードAPIを利用できません。",
  },
};

// The active UI locale. Resolved lazily on first `getLocale()` so this module
// stays importable in a non-browser test runner (no window/navigator/
// localStorage) without side effects at import time.
let activeLocale = null;

/** Determines the initial locale: a previously stored choice wins; otherwise
 * `navigator.language` starting with "ja" auto-selects Japanese; everything
 * else falls back to English. All storage/navigator access is guarded so a
 * private-browsing or non-browser context degrades to "en" instead of
 * throwing. */
export function detectInitialLocale() {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (SUPPORTED_LOCALES.includes(stored)) return stored;
  } catch (err) {
    // localStorage unavailable (private browsing, disabled, non-browser).
  }
  try {
    const lang = typeof navigator !== "undefined" ? navigator.language || "" : "";
    if (lang.toLowerCase().startsWith("ja")) return "ja";
  } catch (err) {
    // navigator unavailable; fall through to the English default.
  }
  return "en";
}

/** Returns the currently active locale, resolving (and caching) the initial
 * one on first call. */
export function getLocale() {
  if (activeLocale === null) activeLocale = detectInitialLocale();
  return activeLocale;
}

/** Switches the active locale, persists the choice (best-effort), and
 * re-renders the whole UI so every label and -- if the generated prompt hasn't
 * been hand-edited -- the prompt itself follow the new language. */
export function setLocale(loc) {
  activeLocale = SUPPORTED_LOCALES.includes(loc) ? loc : "en";
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, activeLocale);
  } catch (err) {
    // localStorage may be unavailable; the choice still applies for this
    // session, it just won't be remembered across reloads.
  }
  renderAll();
}

/** Substitutes `{name}`-style placeholders in `template` from `params`, using
 * a function replacement (not a string one) so a "$" in a substituted value
 * is never interpreted as a replacement pattern, and so a value that itself
 * contains a `{placeholder}` token is inserted verbatim rather than being
 * re-substituted. */
export function substituteParams(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    key in params ? String(params[key]) : match
  );
}

/** Pure message lookup for an explicit `locale`: returns that locale's string
 * for `key`, falling back to English, then to the key itself (so a missing
 * translation never renders as an empty label). Used by the DOM-free
 * prompt/stats builders, which must be deterministic per-locale regardless of
 * whatever locale the surrounding UI happens to be showing. */
export function tr(locale, key, params) {
  const table = MESSAGES[locale] || MESSAGES.en;
  const value = table[key] ?? MESSAGES.en[key] ?? key;
  return substituteParams(value, params);
}

/** UI-facing translation: `tr` against the currently active locale. */
export function t(key, params) {
  return tr(getLocale(), key, params);
}

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
  // The exact text the last `generatePrompt()` wrote into the result
  // textarea, and whether one has ever been generated. Used on a locale
  // switch to decide whether the generated prompt is still pristine (safe to
  // regenerate in the new language) or has been hand-edited (must not be
  // clobbered).
  lastGeneratedPrompt: "",
  promptGenerated: false,
  // Last tree/root load-failure state, as `{ key, params }` (or null when the
  // load succeeded). Kept so a locale switch can re-render the failure message
  // in the new language instead of blanking it out (issue #22): `renderTree`
  // clears `#tree-root` and returns early when there's no `rootNode`, and
  // nothing re-renders `#root-basename` on its own, so without this the
  // failure text would either vanish or stay stuck in the old language.
  treeLoadError: null,
  rootLoadError: null,
};

let el = {};

async function init() {
  wireLocaleSwitcher();
  wireSecurityNotice();
  setSecurityNoticeVisible(!loadSecurityNoticeDismissed());
  // Known/accepted (issue #22, nit): the HTML ships English static chrome, so a
  // ja user can see a brief English flash before this runs. This module is
  // deferred but executes near-immediately, so the flash is negligible;
  // duplicating the whole catalog into the pre-paint HTML to avoid it isn't
  // worth it for a self-hosted single-file tool.
  applyStaticI18n();
  document.documentElement.lang = getLocale();
  syncLocaleControl();
  el.rootBasename.textContent = t("root.loading");
  wirePresetButtons();
  wireSearchInput();
  wireRecentClear();
  wireResizer();
  wireHashNavigation();
  wireCopyMenuDismissal();
  wirePromptComposer();
  updateComposerToggleAria();
  renderRecentList();
  renderContentToolbar();
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
      state.rootLoadError = { key: "root.loadFailedHttp", params: { status: response.status } };
      renderRootBasename();
      return;
    }
    const data = await response.json();
    state.rootLoadError = null;
    el.rootBasename.textContent = data.basename;
    el.rootPath.textContent = data.absolutePath;
  } catch (err) {
    state.rootLoadError = { key: "root.loadFailed", params: null };
    renderRootBasename();
  }
}

/** Re-applies the root-basename load-failure message in the active locale.
 * A successful load shows the real basename (not a translatable string), so
 * this only ever needs to act when a failure is currently latched; it's called
 * both from `loadRoot` and from `renderAll` on a locale switch. */
function renderRootBasename() {
  if (!el.rootBasename) return;
  if (state.rootLoadError) {
    el.rootBasename.textContent = t(state.rootLoadError.key, state.rootLoadError.params);
  }
}

async function loadTree() {
  try {
    const response = await fetch(apiUrl("/api/tree"));
    if (!response.ok) {
      state.treeLoadError = { key: "tree.loadFailedHttp", params: { status: response.status } };
      renderTree();
      return;
    }
    const data = await response.json();
    state.treeLoadError = null;
    state.entries = data.entries;
    buildTree(data.entries);
    renderTree();
    // issue #9: `/api/tree` reports when the resource-exhaustion cap cut the
    // walk short, so an incomplete list never silently looks complete.
    el.treeTruncationWarning.hidden = !data.truncated;
  } catch (err) {
    state.treeLoadError = { key: "tree.loadFailed", params: null };
    renderTree();
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
  // A latched load failure (issue #22) is re-rendered here in the active
  // locale, so a language switch updates the message instead of blanking it
  // (the `!state.rootNode` early return below would otherwise leave it empty).
  if (state.treeLoadError) {
    el.treeRoot.textContent = t(state.treeLoadError.key, state.treeLoadError.params);
    return;
  }
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
    toggle.setAttribute("aria-label", expanded ? t("tree.collapseDir") : t("tree.expandDir"));
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

  if (node.isDir) {
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "tree-dir-copy";
    copyButton.textContent = "⧉";
    copyButton.title = t("tree.dirCopyTitle");
    copyButton.setAttribute(
      "aria-label",
      t("tree.dirCopyAria", { path: node.path || t("tree.rootName") })
    );
    copyButton.addEventListener("click", (event) => {
      event.stopPropagation();
      copyDirectoryContents(node, "markdown", copyButton);
    });
    row.appendChild(copyButton);
  }

  if (!node.isDir && node.likelySecret) {
    const badge = document.createElement("span");
    badge.className = "secret-badge";
    badge.textContent = t("tree.secretBadge");
    badge.title = t("tree.secretTitle");
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

// ---- Copy output formatters (issue #6) ----
//
// These are pure, DOM-free formatting functions (same style/place as
// formatFileRef/formatLinesRef above) that turn already-fetched file content
// into one of four output shapes a user can paste into a sidebar AI chat:
//
// - "plain": a path heading plus the raw content, verbatim. The minimal
//   format; file boundaries between multiple files are only as unambiguous
//   as a human reading the headings makes them.
// - "markdown": a "### <path>" heading followed by a fenced code block,
//   escalating to a longer backtick fence whenever the content itself
//   contains a run of backticks that would otherwise prematurely close a
//   three-backtick fence.
// - "xml": a `<file path="...">...</file>` element. This isn't decorative --
//   it exists so an AI reading multiple concatenated files can never mistake
//   where one file's content ends and the next one's path begins, which
//   plain/markdown headings alone cannot fully guarantee.
// - "diff": deliberately almost identical to "plain" for now. Issue #8 will
//   feed a real `git diff` through this same slot; the job here is only to
//   be a correct receptacle for that future content, not to synthesize a
//   fake diff (e.g. prefixing every line with "+") out of a file's current
//   contents.

const MARKDOWN_LANGUAGE_BY_EXTENSION = {
  rs: "rust",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  py: "python",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  sh: "bash",
  css: "css",
  html: "html",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  md: "markdown",
};

/** Maps a file path's extension to the language identifier used to open a
 * Markdown fenced code block (e.g. "src/app.rs" -> "rust"), for
 * `formatSingleFile`'s and `formatReferenceWithCode`'s "markdown" output.
 * Returns "" for an unrecognized or missing extension, so the fence opens
 * with no language tag rather than a guessed-wrong one. */
export function languageForPath(path) {
  return MARKDOWN_LANGUAGE_BY_EXTENSION[extensionOf(path)] || "";
}

/** Escapes the characters that are unsafe inside a double-quoted XML
 * attribute value: "&" first (so it doesn't double-escape the entities this
 * function is about to insert), then "<", ">", and '"'. */
export function escapeXmlAttribute(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escapes the characters that are unsafe inside XML element text content:
 * "&", "<", and ">". Quotes don't need escaping here (unlike
 * `escapeXmlAttribute`) since this text never sits inside an attribute's own
 * quotes. */
export function escapeXmlText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Picks a Markdown code-fence delimiter long enough that `content` can
 * never prematurely close it: three backticks, escalated to one more than
 * the longest run of consecutive backticks already present in `content`
 * (content containing a triple-backtick run gets a four-backtick fence, and
 * so on). */
export function markdownFenceFor(content) {
  const runs = content.match(/`+/g) || [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Wraps `text` in a Markdown inline code span, the inline-code analog of
 * `markdownFenceFor`: the backtick run is escalated to one longer than the
 * longest run already inside `text` (so a filename containing a backtick,
 * e.g. "out`put.md", can never prematurely close the span), with a padding
 * space on each side whenever `text` itself starts or ends with a backtick
 * (the CommonMark rule for exactly that case). Used for user-supplied text
 * embedded inline in generated prompt text, where a plain single-backtick
 * span would be unsafe. */
export function formatInlineCode(text) {
  const runs = text.match(/`+/g) || [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  return needsPadding ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** Renders `path` and `content` in the shared "plain"/"diff" shape: a path
 * heading, an underline matching its length, then the content verbatim. */
function plainFileBlock(path, content) {
  return `${path}\n${"-".repeat(Math.max(path.length, 3))}\n${content}`;
}

/** Formats one already-fetched file's `path`/`content` in the requested
 * output `format` ("plain" | "markdown" | "xml" | "diff"); see the section
 * comment above for what each format looks like and why. An unrecognized
 * `format` falls back to "plain" rather than throwing, since a UI bug that
 * passes a stale/typo'd format string should degrade gracefully instead of
 * losing the user's clipboard content entirely. */
export function formatSingleFile(path, content, format) {
  switch (format) {
    case "markdown": {
      const fence = markdownFenceFor(content);
      return `### ${path}\n\n${fence}${languageForPath(path)}\n${content}\n${fence}\n`;
    }
    case "xml":
      return `<file path="${escapeXmlAttribute(path)}">${escapeXmlText(content)}</file>`;
    case "diff":
    case "plain":
    default:
      return plainFileBlock(path, content);
  }
}

/** Formats multiple already-fetched files (`entries`: `{ path, content }[]`)
 * as one block of text in the requested output `format`, always sorted by
 * `path` first (the same ordering convention `nextOpenFilesList` -- the
 * right pane's own order, established in issue #4/#5 -- already uses) so the
 * same set of files always produces byte-identical output regardless of
 * check/fetch order. Shared by every "copy more than one file at once"
 * action (a directory, all checked files). "xml" wraps the individual
 * `<file>` elements in a single `<files>` so the boundary between the whole
 * multi-file blob and its surroundings is unambiguous too, not just the
 * boundaries between the files themselves. */
export function formatMultipleFiles(entries, format) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (format === "xml") {
    const body = sorted.map((entry) => formatSingleFile(entry.path, entry.content, "xml")).join("\n");
    return `<files>\n${body}\n</files>`;
  }

  const joiner = format === "markdown" ? "\n" : "\n\n";
  return sorted.map((entry) => formatSingleFile(entry.path, entry.content, format)).join(joiner);
}

/** Groups a flat list of file paths into a nested `{ children: Map }` tree
 * keyed by path segment, inferring each intermediate segment as a directory
 * purely from the fact that something continues past it -- `paths` is
 * assumed to contain file paths only (never an explicit directory path), so
 * a segment with no children of its own is always a file. Pulled out of
 * `formatFileTree` so tree-shaping and text-rendering stay separate. */
function buildPathTree(paths) {
  const root = { children: new Map() };
  for (const path of paths) {
    let node = root;
    for (const segment of path.split("/")) {
      if (!node.children.has(segment)) {
        node.children.set(segment, { children: new Map() });
      }
      node = node.children.get(segment);
    }
  }
  return root;
}

/** Renders `node` (from `buildPathTree`) into indented, one-per-line path
 * segments, appending onto `lines` in place. Mirrors `sortedChildren`'s
 * "directories before files, each alphabetically" ordering so a copied file
 * tree reads in the same order the explorer tree itself does. */
function renderPathTreeLines(node, depth, lines) {
  const names = Array.from(node.children.keys()).sort((a, b) => {
    const aIsDir = node.children.get(a).children.size > 0;
    const bIsDir = node.children.get(b).children.size > 0;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  for (const name of names) {
    const child = node.children.get(name);
    const isDir = child.children.size > 0;
    lines.push(`${"  ".repeat(depth)}${name}${isDir ? "/" : ""}`);
    if (isDir) renderPathTreeLines(child, depth + 1, lines);
  }
}

/** Formats a directory/file tree -- no file contents, just the shape -- for
 * `paths` (a flat list of file paths, assumed already sorted; the nesting
 * itself is derived from the paths' own "/" segments). "xml" is a flat
 * `<tree><file path="..."/>...</tree>` list (a tree has no content
 * boundaries to protect the way file contents do, so there's no need to
 * nest it); "plain"/"diff" render the same indented listing ("diff" has no
 * notion of a tree-shaped diff, so it reuses "plain"); "markdown" wraps that
 * same listing in a fenced code block. */
export function formatFileTree(paths, format) {
  if (format === "xml") {
    const fileTags = paths.map((path) => `<file path="${escapeXmlAttribute(path)}"/>`).join("\n");
    return `<tree>\n${fileTags}\n</tree>`;
  }

  const lines = [];
  renderPathTreeLines(buildPathTree(paths), 0, lines);
  const listing = lines.join("\n");

  return format === "markdown" ? `\`\`\`\n${listing}\n\`\`\`` : listing;
}

/** Formats a stable reference string (`ref`, e.g. from `formatFileRef` or
 * `formatLinesRef`) together with the code it points at, in the requested
 * output `format`. `content` is expected to already be sliced down to
 * whatever `ref` describes (e.g. just the selected line range for an
 * `@lines:` ref) -- this function only formats, it doesn't re-derive which
 * lines to include. The Markdown fence's language is guessed from `ref`'s
 * embedded path via `parseRef`, falling back to no language tag if `ref`
 * isn't a well-formed reference. */
export function formatReferenceWithCode(ref, content, format) {
  const parsed = parseRef(ref);

  switch (format) {
    case "markdown": {
      const fence = markdownFenceFor(content);
      const lang = parsed ? languageForPath(parsed.path) : "";
      return `### ${ref}\n\n${fence}${lang}\n${content}\n${fence}\n`;
    }
    case "xml":
      return `<file ref="${escapeXmlAttribute(ref)}">${escapeXmlText(content)}</file>`;
    case "diff":
    case "plain":
    default:
      return `${ref}\n${content}`;
  }
}

/** Slices `content` down to the 1-indexed, inclusive `start`..`end` line
 * range, dropping a trailing empty element from a final "\n" first (matching
 * how `buildCodeLines` counts a file's displayed line count). Shared by
 * `copyReferenceWithCode` and the prompt composer's `gatherExcerptEntries`,
 * so the one rule for "which lines does a selection actually cover" can
 * never quietly diverge between the two call sites. */
export function sliceSelectedLines(content, start, end) {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(start - 1, end).join("\n");
}

// ---- Prompt composer (issue #7) ----
//
// Builds an editable prompt from four choices (goal, target, output, context
// mode) plus free-form additional instructions, per issue #1/#7. The pure
// pieces here (option lists, `describePromptTarget`/`describePromptOutput`/
// `buildPromptContextSection`/`buildPromptText`) never touch the DOM or the
// network -- they take already-resolved data (refs, fetched file content) and
// return a string, so the composer's actual text generation is fully testable
// without a browser. The DOM/fetch-touching glue (`generatePrompt` and
// friends, further down) is a thin wrapper that gathers that data from
// `state` and calls these.

export const PROMPT_GOALS = [
  { value: "locate", labelKey: "goal.locate.label" },
  { value: "explain", labelKey: "goal.explain.label" },
  { value: "investigate-bug", labelKey: "goal.investigate-bug.label" },
  { value: "review", labelKey: "goal.review.label" },
  { value: "extract-tests", labelKey: "goal.extract-tests.label" },
  { value: "refactor", labelKey: "goal.refactor.label" },
  { value: "plan", labelKey: "goal.plan.label" },
];

export const PROMPT_TARGETS = [
  { value: "page", labelKey: "target.page.label" },
  { value: "checked", labelKey: "target.checked.label" },
  { value: "lines", labelKey: "target.lines.label" },
  { value: "diff", labelKey: "target.diff.label" },
];

export const PROMPT_OUTPUTS = [
  { value: "concise", labelKey: "output.concise.label" },
  { value: "report", labelKey: "output.report.label" },
  { value: "issue", labelKey: "output.issue.label" },
  { value: "instructions", labelKey: "output.instructions.label" },
  { value: "checklist", labelKey: "output.checklist.label" },
  { value: "diff", labelKey: "output.diff.label" },
  { value: "file", labelKey: "output.file.label" },
];

export const PROMPT_CONTEXT_MODES = [
  { value: "page", labelKey: "contextMode.page.label" },
  { value: "excerpts", labelKey: "contextMode.excerpts.label" },
  { value: "full", labelKey: "contextMode.full.label" },
];

/** Describes what `target` refers to, in a form that reads naturally inside
 * a sentence (no trailing period). `data.checkedRefs`/`data.lineRefs` are the
 * already-formatted `@file:...`/`@lines:...` reference strings for the
 * "checked" and "lines" targets respectively; each degrades to an
 * explanatory fallback phrase (rather than an empty/misleading list) when
 * nothing is currently checked/selected, so the resulting prompt still reads
 * as a coherent sentence in that state. */
export function describePromptTarget(target, data = {}, locale = "en") {
  const checkedRefs = data.checkedRefs || [];
  const lineRefs = data.lineRefs || [];

  switch (target) {
    case "checked":
      return checkedRefs.length > 0
        ? tr(locale, "target.checked.phrase", { refs: checkedRefs.join(", ") })
        : tr(locale, "target.checked.empty");
    case "lines":
      return lineRefs.length > 0
        ? tr(locale, lineRefs.length > 1 ? "target.lines.phrasePlural" : "target.lines.phrase", {
            refs: lineRefs.join(", "),
          })
        : tr(locale, "target.lines.empty");
    case "diff":
      return tr(locale, "target.diff.phrase");
    case "page":
    default:
      return tr(locale, "target.page.phrase");
  }
}

/** Describes the requested output shape as a standalone instruction sentence.
 * "file" is special-cased since it also needs `filename`; an empty/blank
 * `filename` falls back to "output.md" so the instruction is always a
 * complete, valid sentence rather than naming an empty file. */
export function describePromptOutput(output, filename, locale = "en") {
  if (output === "file") {
    const name = filename && filename.trim() ? filename.trim() : "output.md";
    return tr(locale, "output.file.instruction", { name: formatInlineCode(name) });
  }
  const key = `output.${output}.instruction`;
  return tr(locale, MESSAGES.en[key] !== undefined ? key : "output.concise.instruction");
}

/** Builds the prompt's "## Context" section, embedding `contextEntries`
 * (`{ ref, content }[]`, already fetched/sliced by the caller) via
 * `formatReferenceWithCode` so each entry gets the same fenced,
 * language-tagged Markdown treatment as every other "reference + code" copy
 * in the app (and, not incidentally, so a checked file whose content happens
 * to contain backticks or a Markdown heading can never corrupt the
 * surrounding prompt structure the way bare, unfenced text would).
 *
 * `target === "diff"` still respects `contextMode` like every other target:
 * "page context only" means "embed nothing, the sidebar AI reads the page
 * itself" -- which for every *other* target is safe because that target's
 * content genuinely is visible on the page, but a diff never is. Rather than
 * silently overriding the user's explicit "don't embed anything" choice
 * (uncommitted diffs routinely carry secrets, debug scaffolding, or other
 * things a user may deliberately not want handed to a third-party AI), that
 * mismatch is surfaced as an explanatory note telling them to switch modes
 * -- the same "can't do what you asked, here's why" honesty this function
 * already uses for "nothing selected/checked yet" below, not a reason to
 * override the choice itself.
 *
 * For "excerpts"/"full" (no separate "just an excerpt of the diff" concept
 * exists -- a diff is already a purpose-built excerpt of the changes, so
 * both modes behave identically here), `contextEntries` comes from
 * `gatherDiffEntries`, which always resolves to exactly one entry carrying
 * either real diff text (`isDiff: true`, wrapped in a fenced, `diff`-tagged
 * code block) or plain-language explanatory prose for "not a Git
 * repository"/"no local changes"/a fetch failure (`isDiff: false`, embedded
 * as-is rather than inside a code fence that would make a plain sentence
 * look like broken diff-formatted code).
 *
 * For every other target, "page context only" returns `""` (rely on the
 * sidebar AI reading the live page itself, so nothing gets embedded in the
 * copied text at all); when `contextMode` calls for embedded content but none
 * was gathered (nothing selected/checked yet), returns an explanatory
 * placeholder instead of an empty/misleading section, so the caller doesn't
 * have to special-case "mode wants content but there isn't any" itself. */
export function buildPromptContextSection(contextMode, contextEntries, target, locale = "en") {
  const heading = tr(locale, "context.heading");

  if (target === "diff") {
    if (contextMode === "page") {
      return tr(locale, "context.diff.pageNote");
    }
    const entry = contextEntries && contextEntries[0];
    // Defensive only: `gatherDiffEntries` always resolves to exactly one entry
    // (never `[]`/`undefined`) for a non-"page" diff target, so this branch is
    // unreachable in production. Reuse the clean-tree wording rather than a
    // second near-identical "no diff" string.
    if (!entry) return tr(locale, "diff.status.clean");
    if (!entry.isDiff) return entry.content;
    const fence = markdownFenceFor(entry.content);
    return `${heading}\n\n${tr(locale, "context.gitDiffHeading")}\n\n${fence}diff\n${entry.content}\n${fence}\n`;
  }

  if (contextMode === "page") return "";

  if (!contextEntries || contextEntries.length === 0) {
    return contextMode === "excerpts"
      ? tr(locale, "context.excerpts.none")
      : tr(locale, "context.full.none");
  }

  const body = contextEntries
    .map((entry) => formatReferenceWithCode(entry.ref, entry.content, "markdown"))
    .join("\n");
  return `${heading}\n\n${body}`;
}

/** Assembles the full editable prompt text from every composer choice. Pure
 * and DOM-free: `checkedRefs`/`lineRefs`/`contextEntries` are already-resolved
 * data (see the section comment above), not derived here. Every
 * goal/target/output/context-mode combination -- including every "nothing
 * selected yet" edge case -- is expected to produce a complete, coherent
 * block of text; degrading gracefully rather than omitting a section is the
 * job of `describePromptTarget`/`buildPromptContextSection` above. */
export function buildPromptText(options, locale = "en") {
  const {
    goal,
    target,
    output,
    contextMode,
    filename,
    extraInstructions,
    checkedRefs = [],
    lineRefs = [],
    contextEntries = [],
  } = options;

  const goalKey = `goal.${goal}.instruction`;
  const parts = [
    tr(locale, MESSAGES.en[goalKey] !== undefined ? goalKey : "goal.explain.instruction"),
    tr(locale, "prompt.targetLine", {
      target: describePromptTarget(target, { checkedRefs, lineRefs }, locale),
    }),
    describePromptOutput(output, filename, locale),
  ];

  const trimmedExtra = (extraInstructions || "").trim();
  if (trimmedExtra) {
    parts.push(tr(locale, "prompt.additionalInstructions", { text: trimmedExtra }));
  }

  parts.push(tr(locale, "prompt.referenceNote"));

  const contextSection = buildPromptContextSection(contextMode, contextEntries, target, locale);
  if (contextSection) parts.push(contextSection);

  return parts.join("\n\n");
}

// ---- Selection size statistics (issue #8) ----
//
// A rough, clearly-labeled sense of how big the current selection is --
// file count, character count, and an estimated (never claimed exact) token
// count -- plus a warning once it gets unusually large. Pure and DOM-free:
// `computeSelectionStats` takes already-known data (the checked paths, the
// content cache) and returns numbers; `formatSelectionStats` turns those
// numbers into the one line of text the toolbar displays.

// A widely-used rough heuristic for English-ish source/prose text (roughly
// 4 characters per token for most tokenizers); deliberately not tied to any
// specific model's real tokenizer, since this tool is vendor-neutral and
// has no API access to a real one. Labeled "rough estimate" everywhere it's
// shown, per issue #8's "a clearly labeled token estimate rather than
// claiming exact model tokens" requirement.
const CHARS_PER_TOKEN_ESTIMATE = 4;

// Past this many characters, the selection is flagged as "large" in the
// toolbar. Not tied to any specific model's context window (this tool has
// no way to know which sidebar AI or chat model the copied text will end up
// in) -- just a soft, order-of-magnitude heuristic (roughly 50k estimated
// tokens) meant to catch an accidental "select everything" before it's
// copied, not a hard limit enforced anywhere.
const LARGE_SELECTION_CHAR_THRESHOLD = 200_000;

/** Computes size statistics for `checkedPaths` (assumed already the current
 * selection) using whatever content is already available in
 * `fileContentCache` -- a checked path with no cache entry yet (still being
 * fetched) contributes to `fileCount` but not yet to `charCount`, and is
 * counted in `pendingCount` so the caller can say so rather than silently
 * under-reporting the total. */
export function computeSelectionStats(checkedPaths, fileContentCache) {
  let charCount = 0;
  let pendingCount = 0;

  for (const path of checkedPaths) {
    const content = fileContentCache.get(path);
    if (content === undefined) {
      pendingCount += 1;
    } else {
      charCount += content.length;
    }
  }

  return {
    fileCount: checkedPaths.length,
    pendingCount,
    charCount,
    estimatedTokens: Math.ceil(charCount / CHARS_PER_TOKEN_ESTIMATE),
    isLarge: charCount > LARGE_SELECTION_CHAR_THRESHOLD,
  };
}

/** Inserts a "," every three digits, e.g. 1234567 -> "1,234,567". A small
 * hand-rolled formatter rather than `Number.prototype.toLocaleString()`:
 * `toLocaleString()`'s grouping/separator depends on the runtime's available
 * ICU data and default locale, which can differ between a full browser and a
 * minimal Node build (including this project's own test runner) -- this
 * keeps the displayed (and tested) format identical everywhere. */
export function formatWithThousandsSeparator(value) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Formats a [`computeSelectionStats`] result as the one line of text the
 * content toolbar displays. */
export function formatSelectionStats(stats, locale = "en") {
  const { fileCount, pendingCount, charCount, estimatedTokens, isLarge } = stats;

  if (fileCount === 0) return tr(locale, "stats.none");

  const fileLabel =
    fileCount === 1 ? tr(locale, "stats.oneFile") : tr(locale, "stats.manyFiles", { count: fileCount });
  const pendingSuffix = pendingCount > 0 ? tr(locale, "stats.pending", { count: pendingCount }) : "";
  const base = tr(locale, "stats.base", {
    files: fileLabel,
    pending: pendingSuffix,
    chars: formatWithThousandsSeparator(charCount),
    tokens: formatWithThousandsSeparator(estimatedTokens),
  });

  return isLarge ? `${base}${tr(locale, "stats.large")}` : base;
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
      state.fileContentCache.set(path, t("file.loadFailedHttp", { status: response.status }));
    } else {
      const text = await response.text();
      state.fileContentCache.set(path, text);
    }
  } catch (err) {
    state.fileContentCache.set(path, t("file.loadFailed", { err }));
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
  renderContentToolbar();
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
  toggle.setAttribute("aria-label", collapsed ? t("filePanel.expand") : t("filePanel.collapse"));
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

  const actions = document.createElement("div");
  actions.className = "file-panel-actions";
  actions.appendChild(
    buildCopyActionGroup(
      t("copy.copy"),
      (button) => copyFileAs(path, "markdown", button),
      () => filePanelCopyMenuItems(path)
    )
  );
  header.appendChild(actions);

  article.appendChild(header);

  if (!collapsed) {
    const pre = document.createElement("pre");
    pre.className = "file-panel-body";
    const code = document.createElement("code");
    code.className = "file-panel-code";

    if (!state.fileContentCache.has(path)) {
      code.textContent = t("file.loading");
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

// ---- Copy actions (clipboard) ----
//
// Every copy affordance in the UI (a file panel's "Copy" button and its "⋯"
// menu, a tree directory row's hover copy icon, the global toolbar's "Copy
// all checked" button and its "⋯" menu) funnels through the same two
// pieces here -- `copyTextToClipboard` (the actual clipboard write) and
// `flashCopyFeedback` (the transient on-button "Copied!"/"Copy failed" cue)
// -- so success and failure always look and behave the same everywhere.

const COPY_FEEDBACK_MS = 1500;

/** Writes `text` to the system clipboard via the async Clipboard API,
 * returning `{ ok: true }` on success or `{ ok: false, error }` on failure
 * (no Clipboard API in this context, an insecure origin, a denied
 * permission, etc.) instead of letting the rejection propagate, so every
 * call site can `await` this and branch on `.ok` without its own try/catch.
 * `error` is always a plain string, suitable for direct display. */
export async function copyTextToClipboard(text) {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof navigator.clipboard.writeText !== "function"
  ) {
    return { ok: false, error: t("clipboard.unavailable") };
  }

  try {
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message !== undefined ? String(err.message) : String(err),
    };
  }
}

let copyToastTimeoutId = null;

/** Shows a transient toast notification at the page level, for the case
 * where the button a copy action started from no longer exists in the DOM
 * by the time the (possibly slow, multi-file) copy finishes -- see
 * `flashCopyFeedback`'s `isConnected` check below. Unlike `flashCopyFeedback`,
 * this has nowhere to read an "original label" back from, so it always just
 * shows and then hides itself after `COPY_FEEDBACK_MS`, the same duration the
 * on-button cue uses. */
function showCopyToast(ok, error) {
  if (!el.copyToast) return;
  el.copyToast.textContent = ok
    ? t("toast.copied")
    : t("toast.copyFailed", { error: error || t("toast.unknownError") });
  el.copyToast.classList.toggle("copy-toast-success", ok);
  el.copyToast.classList.toggle("copy-toast-failure", !ok);
  el.copyToast.hidden = false;

  window.clearTimeout(copyToastTimeoutId);
  copyToastTimeoutId = window.setTimeout(() => {
    el.copyToast.hidden = true;
  }, COPY_FEEDBACK_MS);
}

/** Shows a transient "Copied!"/"Copy failed" label on `button`, reverting to
 * its original label after `COPY_FEEDBACK_MS` -- the same fade-back shape as
 * `flashHighlight`'s `.nav-flash` cue (issue #5), just on a button's text
 * instead of an outline. The button is disabled for the duration so a second
 * click can't pile up overlapping reverts; on failure, `error` is surfaced
 * via the button's `title` tooltip, since the label itself only has room for
 * a short word.
 *
 * A multi-file copy re-fetches every file before writing to the clipboard
 * (`fetchFileContents`), which can take long enough for the user to trigger a
 * re-render (e.g. toggling a checkbox rebuilds the tree/file panels via
 * `innerHTML = ""`) that detaches `button` from the document before this
 * runs. Reflecting success/failure on a detached button would be silently
 * invisible, so that case falls back to the page-level `showCopyToast`
 * instead. */
function flashCopyFeedback(button, ok, error) {
  if (!button.isConnected) {
    showCopyToast(ok, error);
    return;
  }

  const originalLabel = button.dataset.copyOriginalLabel ?? button.textContent;
  button.dataset.copyOriginalLabel = originalLabel;

  button.textContent = ok ? t("copy.copied") : t("copy.failed");
  button.classList.toggle("copy-success", ok);
  button.classList.toggle("copy-failure", !ok);
  button.title = ok ? "" : error || t("copy.failed");
  button.disabled = true;

  window.setTimeout(() => {
    button.textContent = originalLabel;
    button.classList.remove("copy-success", "copy-failure");
    button.title = "";
    button.disabled = false;
    delete button.dataset.copyOriginalLabel;
  }, COPY_FEEDBACK_MS);
}

/** Writes `text` to the clipboard and reflects the result on `button` via
 * `flashCopyFeedback` -- the one function every copy action in the app calls
 * to go from "formatted text" to "in the clipboard, with feedback shown". */
async function copyToClipboardWithFeedback(text, button) {
  const result = await copyTextToClipboard(text);
  flashCopyFeedback(button, result.ok, result.error);
  return result;
}

/** Fetches the current content of every path in `paths` from `/api/file`, in
 * parallel. Used by every copy action that spans more than one file (a
 * directory's contents, all checked files) instead of reading
 * `state.fileContentCache`, since that cache can be empty or still hold a
 * "Loading…" placeholder for a file that was only just opened -- copying
 * that placeholder text would silently corrupt the clipboard output. Throws
 * (so the caller's `catch` can report a clipboard failure) if any single
 * fetch fails, rather than silently omitting that file, since a copy that
 * dropped one file without saying so would violate this issue's "file
 * boundaries are unambiguous" acceptance criterion. */
export async function fetchFileContents(paths) {
  return Promise.all(
    paths.map(async (path) => {
      const response = await fetch(apiUrl(`/api/file?path=${encodeURIComponent(path)}`));
      if (!response.ok) {
        // Technical detail only (path + HTTP status): the user-facing
        // "copy failed" prefix is localized by `toast.copyFailed` /
        // `file.loadFailed` at the display site (issue #22), so this message
        // must not carry its own English prose or it would leak past them.
        throw new Error(`"${path}": HTTP ${response.status}`);
      }
      const content = await response.text();
      return { path, content };
    })
  );
}

export function formatLabel(format) {
  switch (format) {
    case "xml":
      return "XML";
    case "diff":
      return "Diff";
    case "markdown":
      return "Markdown";
    case "plain":
    default:
      return "Plain";
  }
}

// A dropdown ("⋯") menu built by `buildCopyActionGroup`, currently open (if
// any). Tracked as module state, rather than one `document`-level "click
// outside" listener per menu instance, so repeatedly re-rendering the tree
// or file panels (which rebuilds every menu's DOM from scratch) never
// accumulates extra listeners on `document` -- there is exactly one such
// listener for the whole app, wired once in `init` via
// `wireCopyMenuDismissal`.
let openCopyMenu = null;

function closeOpenCopyMenu() {
  if (!openCopyMenu) return;
  openCopyMenu.menu.style.display = "none";
  openCopyMenu.toggleButton.setAttribute("aria-expanded", "false");
  openCopyMenu = null;
}

function wireCopyMenuDismissal() {
  document.addEventListener("click", (event) => {
    if (openCopyMenu && !openCopyMenu.wrap.contains(event.target)) {
      closeOpenCopyMenu();
    }
  });
}

/** Builds the shared "always-visible primary button + '⋯' overflow menu"
 * control used by every copy affordance in the app (a file panel's header, a
 * tree directory row, the global toolbar). `getMenuItems()` is called fresh
 * every time the "⋯" menu is opened (not once at build time), so its
 * contents -- e.g. whether "Copy reference + code" appears at all -- always
 * reflect the current selection/checked state rather than whatever it was
 * when this button cluster was first rendered. Each item is
 * `{ label, onClick(button), disabled? }`; `onClick`/`onPrimary` receive the
 * button element that was clicked so they can pass it straight to
 * `copyToClipboardWithFeedback`. */
function buildCopyActionGroup(primaryLabel, onPrimary, getMenuItems) {
  const wrap = document.createElement("div");
  wrap.className = "copy-action-group";

  const primaryButton = document.createElement("button");
  primaryButton.type = "button";
  primaryButton.className = "copy-button copy-button-primary";
  primaryButton.textContent = primaryLabel;
  primaryButton.addEventListener("click", () => {
    closeOpenCopyMenu();
    onPrimary(primaryButton);
  });
  wrap.appendChild(primaryButton);

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "copy-menu-toggle";
  menuButton.textContent = "⋯";
  menuButton.setAttribute("aria-label", t("copy.moreOptions"));
  menuButton.setAttribute("aria-expanded", "false");
  wrap.appendChild(menuButton);

  const menu = document.createElement("div");
  menu.className = "copy-menu";
  menu.style.display = "none";
  wrap.appendChild(menu);

  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();

    if (openCopyMenu && openCopyMenu.menu === menu) {
      closeOpenCopyMenu();
      return;
    }
    closeOpenCopyMenu();

    menu.innerHTML = "";
    for (const item of getMenuItems()) {
      const itemButton = document.createElement("button");
      itemButton.type = "button";
      itemButton.className = "copy-menu-item";
      itemButton.textContent = item.label;
      itemButton.disabled = Boolean(item.disabled);
      itemButton.addEventListener("click", () => {
        closeOpenCopyMenu();
        item.onClick(itemButton);
      });
      menu.appendChild(itemButton);
    }

    menu.style.display = "flex";
    menuButton.setAttribute("aria-expanded", "true");
    openCopyMenu = { menu, toggleButton: menuButton, wrap };
  });

  return wrap;
}

/** Copies file `path`'s current content (re-fetched, not read from the
 * possibly-stale/"Loading…" `state.fileContentCache`) formatted as `format`,
 * reflecting the result on `button`. */
async function copyFileAs(path, format, button) {
  try {
    const [entry] = await fetchFileContents([path]);
    const text = formatSingleFile(path, entry.content, format);
    await copyToClipboardWithFeedback(text, button);
  } catch (err) {
    flashCopyFeedback(button, false, err && err.message ? err.message : String(err));
  }
}

/** Copies `path`'s stable `@lines:...` reference together with the code in
 * `selection`'s range (re-fetched fresh, for the same reason `copyFileAs`
 * does), formatted as Markdown -- the app-wide default format for every
 * "copy" primary/menu action. */
async function copyReferenceWithCode(path, selection, button) {
  try {
    const [entry] = await fetchFileContents([path]);
    const selectedCode = sliceSelectedLines(entry.content, selection.start, selection.end);
    const ref = formatLinesRef(path, selection.start, selection.end);
    const text = formatReferenceWithCode(ref, selectedCode, "markdown");
    await copyToClipboardWithFeedback(text, button);
  } catch (err) {
    flashCopyFeedback(button, false, err && err.message ? err.message : String(err));
  }
}

/** Menu items for a file panel's "⋯" button: the three non-default output
 * formats for a whole-file copy, a reference-only copy, and -- only while
 * `path` has an active line selection -- a reference-plus-code copy. */
function filePanelCopyMenuItems(path) {
  const items = ["plain", "xml", "diff"].map((format) => ({
    label: t("menu.copyFileAs", { format: formatLabel(format) }),
    onClick: (button) => copyFileAs(path, format, button),
  }));

  items.push({
    label: t("menu.copyReferenceOnly"),
    onClick: (button) => copyToClipboardWithFeedback(formatFileRef(path), button),
  });

  const selection = state.lineSelections.get(path);
  if (selection) {
    items.push({
      label: t("menu.copyReferenceAndCode"),
      onClick: (button) => copyReferenceWithCode(path, selection, button),
    });
  }

  return items;
}

/** Copies every file under directory `node` (via its precomputed
 * `fileDescendants`), formatted as `format`, reflecting the result on
 * `button`. Used by the tree row's hover copy icon (always Markdown, the
 * app-wide default). */
async function copyDirectoryContents(node, format, button) {
  try {
    const entries = await fetchFileContents(node.fileDescendants);
    const text = formatMultipleFiles(entries, format);
    await copyToClipboardWithFeedback(text, button);
  } catch (err) {
    flashCopyFeedback(button, false, err && err.message ? err.message : String(err));
  }
}

/** Copies every currently-checked file, formatted as `format`. A no-op while
 * nothing is checked (the caller is also expected to disable the triggering
 * control in that state; this is a defensive backstop). */
async function copyAllChecked(format, button) {
  if (state.checked.size === 0) return;
  try {
    const entries = await fetchFileContents(Array.from(state.checked));
    const text = formatMultipleFiles(entries, format);
    await copyToClipboardWithFeedback(text, button);
  } catch (err) {
    flashCopyFeedback(button, false, err && err.message ? err.message : String(err));
  }
}

/** Copies the whole project's file tree (every file path currently known
 * from `/api/tree`, not just checked ones -- a tree has no "selection"
 * concept of its own). Always sorted by path first, satisfying
 * `formatFileTree`'s "already sorted" precondition regardless of the order
 * `/api/tree` happened to return entries in. */
async function copyFileTree(button) {
  try {
    const paths = state.entries
      .filter((entry) => !entry.is_dir)
      .map((entry) => entry.path)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const text = formatFileTree(paths, "markdown");
    await copyToClipboardWithFeedback(text, button);
  } catch (err) {
    flashCopyFeedback(button, false, err && err.message ? err.message : String(err));
  }
}

/** Menu items for the global toolbar's "⋯" button: the three non-default
 * output formats for a checked-files copy (disabled while nothing is
 * checked), plus "Copy file tree" (never disabled; it doesn't depend on the
 * checked set at all). */
function globalCopyMenuItems() {
  const hasChecked = state.checked.size > 0;

  const items = ["plain", "xml", "diff"].map((format) => ({
    label: t("menu.copyAllCheckedAs", { format: formatLabel(format) }),
    disabled: !hasChecked,
    onClick: (button) => copyAllChecked(format, button),
  }));

  items.push({
    label: t("menu.copyFileTree"),
    onClick: (button) => copyFileTree(button),
  });

  return items;
}

/** Rebuilds the content pane's toolbar: the "N files open" count, the
 * selection size statistics (issue #8), and the "Copy all checked" button
 * cluster. Called every time the open-files list or a file's cached content
 * might have changed (from `renderFilePanels`, so the character/token counts
 * stay live as each checked file's content finishes loading) and once at
 * startup (from `init`), since `state.openFiles`/`state.checked` are
 * otherwise only updated as a side effect of tree/checkbox interactions this
 * toolbar has no other hook into. */
function renderContentToolbar() {
  const count = state.openFiles.length;
  el.contentToolbarCount.textContent =
    count === 1 ? t("toolbar.oneFileOpen") : t("toolbar.manyFilesOpen", { count });

  // Order doesn't matter for computeSelectionStats's sums, so skip the sort
  // this function's other Array.from(state.checked) call sites need for
  // deterministic output ordering -- this one has no such requirement, and
  // this function runs on every single file-panel render.
  const stats = computeSelectionStats(Array.from(state.checked), state.fileContentCache);
  el.contentToolbarStats.textContent = formatSelectionStats(stats, getLocale());
  el.contentToolbarStats.classList.toggle("content-toolbar-stats-warning", stats.isLarge);

  el.contentToolbarActions.innerHTML = "";
  const group = buildCopyActionGroup(
    t("toolbar.copyAllChecked"),
    (button) => copyAllChecked("markdown", button),
    globalCopyMenuItems
  );
  group.querySelector(".copy-button-primary").disabled = state.checked.size === 0;
  el.contentToolbarActions.appendChild(group);
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

const SVG_NS = "http://www.w3.org/2000/svg";

/** Small decorative icon prefixing each recent-file row's reopen button
 * (issue #26): a curved re-select arrow, distinct from the `✕` remove
 * button, so a user can tell at a glance that clicking the name re-selects
 * the file rather than doing something destructive. Purely decorative --
 * the row's accessible name still comes from the filename text. */
function createRecentReopenIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "recent-reopen-icon");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M12.5 5A5 5 0 1 0 13.5 8.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linecap", "round");
  svg.appendChild(path);

  const arrowhead = document.createElementNS(SVG_NS, "path");
  arrowhead.setAttribute("d", "M12.5 2v3.3h-3.3");
  arrowhead.setAttribute("fill", "none");
  arrowhead.setAttribute("stroke", "currentColor");
  arrowhead.setAttribute("stroke-width", "1.2");
  arrowhead.setAttribute("stroke-linecap", "round");
  arrowhead.setAttribute("stroke-linejoin", "round");
  svg.appendChild(arrowhead);

  return svg;
}

// ---- Security notice dismiss/reopen (issue #28, localStorage) ----
//
// Same best-effort persistence pattern as `loadRecent`/`saveRecent` above and
// `detectInitialLocale`/`setLocale`: a failing `localStorage` (private
// browsing, disabled, non-browser) degrades to "not dismissed" / "the choice
// just doesn't stick across reloads" rather than throwing.

export function loadSecurityNoticeDismissed() {
  try {
    return localStorage.getItem(SECURITY_NOTICE_STORAGE_KEY) === "1";
  } catch (err) {
    return false;
  }
}

export function saveSecurityNoticeDismissed(dismissed) {
  try {
    if (dismissed) {
      localStorage.setItem(SECURITY_NOTICE_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(SECURITY_NOTICE_STORAGE_KEY);
    }
  } catch (err) {
    // localStorage may be unavailable; the choice still applies for this
    // load, it just won't be remembered across reloads.
  }
}

/** Shows the full `#security-notice` or its collapsed `#security-notice-
 * collapsed` strip -- never both -- via the `hidden` attribute (not a class
 * or inline style) so `role="note"` keeps working normally on the full
 * notice when it's visible and each element is removed from the
 * accessibility tree -- not just visually masked -- when it isn't the one
 * showing. `aria-expanded` on the collapsed strip tracks whether the notice
 * it controls is currently expanded (issue #36: dismissing/reopening is now
 * a single in-place toggle in this one page slot, not a separate button
 * elsewhere in the UI). */
function setSecurityNoticeVisible(visible) {
  if (el.securityNotice) {
    el.securityNotice.hidden = !visible;
  }
  if (el.securityNoticeCollapsed) {
    el.securityNoticeCollapsed.hidden = visible;
    el.securityNoticeCollapsed.setAttribute("aria-expanded", String(visible));
  }
}

function wireSecurityNotice() {
  if (el.securityNoticeDismiss) {
    el.securityNoticeDismiss.addEventListener("click", () => {
      saveSecurityNoticeDismissed(true);
      setSecurityNoticeVisible(false);
    });
  }
  if (el.securityNoticeCollapsed) {
    el.securityNoticeCollapsed.addEventListener("click", () => {
      saveSecurityNoticeDismissed(false);
      setSecurityNoticeVisible(true);
    });
  }
}

function renderRecentList() {
  const list = loadRecent();
  el.recentList.innerHTML = "";

  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "recent-empty";
    li.textContent = t("recent.empty");
    el.recentList.appendChild(li);
    return;
  }

  for (const path of list) {
    const li = document.createElement("li");
    li.className = "recent-item";

    const reopenButton = document.createElement("button");
    reopenButton.type = "button";
    reopenButton.className = "recent-reopen";
    reopenButton.title = path;
    reopenButton.appendChild(createRecentReopenIcon());
    const reopenLabel = document.createElement("span");
    reopenLabel.className = "recent-reopen-label";
    reopenLabel.textContent = path;
    reopenButton.appendChild(reopenLabel);
    reopenButton.addEventListener("click", () => reopenFromRecent(path));
    li.appendChild(reopenButton);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "recent-remove";
    removeButton.textContent = "✕";
    removeButton.setAttribute("aria-label", t("recent.removeAria", { path }));
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

// ---- Prompt composer (DOM wiring) ----
//
// Thin glue between the pure functions above and the page: populates the
// four `<select>`s, gathers the current selection/checked/line-selection
// state into the shape `buildPromptText` expects (fetching file content only
// when the chosen context mode actually needs it embedded), and writes the
// result into the editable result textarea. The "Copy prompt" button copies
// the textarea's *current* value, not a freshly regenerated one, so a user's
// manual edits are what actually gets copied and survive until "Generate
// prompt" is clicked again (issue #7 acceptance criterion).

function populateSelect(select, options) {
  select.append(...options.map((option) => new Option(t(option.labelKey), option.value)));
}

/** Clears and re-fills every composer `<select>` with the current locale's
 * option labels, preserving each select's currently chosen value (the option
 * `value`s never change between locales, only their display labels). */
function repopulatePromptSelects() {
  const selects = [
    [el.promptGoal, PROMPT_GOALS],
    [el.promptTarget, PROMPT_TARGETS],
    [el.promptOutput, PROMPT_OUTPUTS],
    [el.promptContextMode, PROMPT_CONTEXT_MODES],
  ];
  for (const [select, options] of selects) {
    const current = select.value;
    select.innerHTML = "";
    populateSelect(select, options);
    if (options.some((option) => option.value === current)) select.value = current;
  }
}

function wirePromptComposer() {
  populateSelect(el.promptGoal, PROMPT_GOALS);
  populateSelect(el.promptTarget, PROMPT_TARGETS);
  populateSelect(el.promptOutput, PROMPT_OUTPUTS);
  populateSelect(el.promptContextMode, PROMPT_CONTEXT_MODES);

  el.promptOutput.addEventListener("change", updatePromptFilenameVisibility);
  updatePromptFilenameVisibility();

  // Disabling both buttons for the duration of `generatePrompt()` (an
  // `await`-ing async function) isn't just UX polish: a disabled button
  // can't dispatch a "click" event at all, so this is what actually rules
  // out a second "Generate" click racing the first one's still-pending fetch
  // and overwriting the result with a stale response (and rules out "Copy"
  // grabbing a known-stale textarea value mid-regeneration).
  el.promptGenerate.addEventListener("click", async () => {
    el.promptGenerate.disabled = true;
    el.promptCopy.disabled = true;
    try {
      await generatePrompt();
    } finally {
      el.promptGenerate.disabled = false;
      el.promptCopy.disabled = false;
    }
  });

  el.promptCopy.addEventListener("click", () => {
    copyToClipboardWithFeedback(el.promptResult.value, el.promptCopy);
  });

  el.promptComposerToggle.addEventListener("click", () => {
    const collapsed = el.promptComposerBody.hidden;
    el.promptComposerBody.hidden = !collapsed;
    el.promptComposerToggle.textContent = collapsed ? "▾" : "▸";
    el.promptComposerToggle.setAttribute("aria-expanded", String(collapsed));
    updateComposerToggleAria();
  });
}

/** Sets the composer toggle's `aria-label` from its current expanded/collapsed
 * state in the active locale. Kept separate from the click handler so a locale
 * switch can refresh the label without toggling the panel. */
function updateComposerToggleAria() {
  const expanded = !el.promptComposerBody.hidden;
  el.promptComposerToggle.setAttribute(
    "aria-label",
    expanded ? t("promptComposer.collapse") : t("promptComposer.expand")
  );
}

function updatePromptFilenameVisibility() {
  el.promptFilenameField.hidden = el.promptOutput.value !== "file";
}

/** Resolves each of `paths`'s content, preferring whatever is already sitting
 * in `state.fileContentCache` (populated whenever a file is opened in the
 * right pane; `.has(path)` is false until a fetch actually completes, so this
 * can never pick up a stale/partial value) over an extra network round trip,
 * and only fetching the paths that aren't cached yet. A single path's fetch
 * failure becomes that one path's placeholder content rather than rejecting
 * the whole batch (unlike `fetchFileContents`, whose fail-fast contract is
 * correct for its own callers -- a clipboard copy that silently dropped one
 * file would violate issue #6's "file boundaries are unambiguous" criterion
 * -- but wrong here, where losing every other already-fetched file over one
 * bad path would make the composer worse than embedding nothing for that one
 * path). Shared by `gatherExcerptEntries`/`gatherFullFileEntries`, the
 * composer's two content-embedding context modes. */
async function resolveFileContents(paths) {
  const uncached = paths.filter((path) => !state.fileContentCache.has(path));
  const fetched = await Promise.all(
    uncached.map(async (path) => {
      try {
        const [entry] = await fetchFileContents([path]);
        return entry;
      } catch (err) {
        // Reuse the same localized placeholder the single-file open path uses
        // (issue #22), so a failed embed never leaks an English literal into
        // the generated prompt. The technical detail (path/HTTP, from
        // `fetchFileContents`) stays as-is in `{err}`.
        return {
          path,
          content: tr(getLocale(), "file.loadFailed", { err: err && err.message ? err.message : err }),
        };
      }
    })
  );
  const fetchedByPath = new Map(fetched.map((entry) => [entry.path, entry.content]));
  return new Map(paths.map((path) => [path, state.fileContentCache.get(path) ?? fetchedByPath.get(path)]));
}

/** Resolves `lineSelectionEntries` (`[path, { start, end }][]`, from
 * `state.lineSelections`) down to just each one's selected range, returning
 * `{ ref, content }[]` for `buildPromptContextSection`'s "excerpts" mode.
 * Uses the same `sliceSelectedLines` `copyReferenceWithCode` uses for a
 * single file, generalized to every currently selected file at once. */
async function gatherExcerptEntries(lineSelectionEntries) {
  if (lineSelectionEntries.length === 0) return [];

  const contentByPath = await resolveFileContents(lineSelectionEntries.map(([path]) => path));

  return lineSelectionEntries.map(([path, selection]) => ({
    ref: formatLinesRef(path, selection.start, selection.end),
    content: sliceSelectedLines(contentByPath.get(path) || "", selection.start, selection.end),
  }));
}

/** Resolves every path in `paths` to its full content, returning `{ ref,
 * content }[]` for `buildPromptContextSection`'s "full" mode. */
async function gatherFullFileEntries(paths) {
  if (paths.length === 0) return [];
  const contentByPath = await resolveFileContents(paths);
  return paths.map((path) => ({ ref: formatFileRef(path), content: contentByPath.get(path) || "" }));
}

/** Fetches `/api/diff` (issue #8) and always resolves to exactly one entry
 * for `buildPromptContextSection`'s target-"diff" case -- never an empty
 * array -- so that function never needs its own "nothing to embed yet"
 * fallback for this target the way "excerpts"/"full" do. `ref: "@diff"`
 * keeps the entry shaped like every other gather* function's output (`{
 * ref, content }`) even though `buildPromptContextSection` doesn't currently
 * read it, so a future refactor that unifies the diff branch with the
 * shared `formatReferenceWithCode` path won't find a silently-missing `ref`.
 * `isDiff` distinguishes the two kinds of `content` this can resolve to:
 * `true` for real diff text (rendered inside a fenced, `diff`-tagged code
 * block), `false` for plain-language explanatory prose -- not a Git
 * repository, a clean working tree, or the request itself failing -- which
 * must NOT be wrapped in a diff-language code fence the way real diff text
 * is, or a plain sentence would visually read as malformed diff output. */
/** Pure `/api/diff` response -> `{ content, isDiff }` resolver, split out of
 * `gatherDiffEntries` so the localized status prose (issue #22) is testable
 * without a network round trip. `data` is the parsed response (`{ isGitRepo,
 * diff }`); `locale` selects the language of the plain-text status lines. Real
 * diff text (`isDiff: true`) is returned verbatim -- it is not translatable and
 * gets rendered inside a `diff`-tagged code fence by `buildPromptContextSection`
 * -- while the "not a repo"/"clean tree" cases become localized prose
 * (`isDiff: false`) that must NOT be fenced. Fetch/HTTP failures are handled by
 * `gatherDiffEntries` itself, since they aren't derivable from `data`. */
export function describeGitDiff(data, locale = "en") {
  if (!data.isGitRepo) {
    return { content: tr(locale, "diff.status.notRepo"), isDiff: false };
  }
  if (!data.diff) {
    return { content: tr(locale, "diff.status.clean"), isDiff: false };
  }
  return { content: data.diff, isDiff: true };
}

async function gatherDiffEntries() {
  const locale = getLocale();
  try {
    const response = await fetch(apiUrl("/api/diff"));
    if (!response.ok) {
      return [
        {
          ref: "@diff",
          content: tr(locale, "diff.status.loadFailed", { detail: `HTTP ${response.status}` }),
          isDiff: false,
        },
      ];
    }
    const { content, isDiff } = describeGitDiff(await response.json(), locale);
    return [{ ref: "@diff", content, isDiff }];
  } catch (err) {
    return [
      {
        ref: "@diff",
        content: tr(locale, "diff.status.loadFailed", {
          detail: err && err.message ? err.message : String(err),
        }),
        isDiff: false,
      },
    ];
  }
}

/** Gathers the composer's current form values plus whatever `state` data
 * `buildPromptText` needs for them, resolves any content the chosen context
 * mode (or, for target "diff", the diff itself) requires embedding, and
 * writes the generated prompt into the result textarea. */
async function generatePrompt() {
  const goal = el.promptGoal.value;
  const target = el.promptTarget.value;
  const output = el.promptOutput.value;
  const contextMode = el.promptContextMode.value;
  const filename = el.promptFilename.value;
  const extraInstructions = el.promptExtra.value;

  const checkedPaths = Array.from(state.checked).sort();
  const checkedRefs = checkedPaths.map(formatFileRef);

  const lineSelectionEntries = Array.from(state.lineSelections.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const lineRefs = lineSelectionEntries.map(([path, selection]) =>
    formatLinesRef(path, selection.start, selection.end)
  );

  let contextEntries = [];
  if (target === "diff") {
    // "page" mode never embeds the diff (see buildPromptContextSection's
    // doc comment for why) -- skip fetching it at all, since the result
    // would only be discarded.
    if (contextMode !== "page") {
      contextEntries = await gatherDiffEntries();
    }
  } else if (contextMode === "excerpts") {
    contextEntries = await gatherExcerptEntries(lineSelectionEntries);
  } else if (contextMode === "full") {
    contextEntries = await gatherFullFileEntries(checkedPaths);
  }

  const text = buildPromptText(
    {
      goal,
      target,
      output,
      contextMode,
      filename,
      extraInstructions,
      checkedRefs,
      lineRefs,
      contextEntries,
    },
    getLocale()
  );
  el.promptResult.value = text;
  state.lastGeneratedPrompt = text;
  state.promptGenerated = true;
}

// ---- Language switching (issue #22) ----
//
// One active locale drives both the static chrome (filled from `data-i18n*`
// attributes in the HTML) and every JS-rendered label. Switching languages
// re-applies both, re-populates the composer's `<select>` option labels, and
// -- only if the generated prompt is still exactly what the last
// `generatePrompt()` produced (i.e. not hand-edited) -- regenerates it in the
// new language so a user's manual edits are never silently clobbered.

/** Walks the `data-i18n` family of attributes on `root` and fills each
 * element's text / placeholder / aria-label / title from the active locale.
 * Idempotent, so it's safe to call on every locale switch. */
function applyStaticI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  });
  root.querySelectorAll("[data-i18n-aria]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.i18nAria));
  });
  root.querySelectorAll("[data-i18n-title]").forEach((node) => {
    node.setAttribute("title", t(node.dataset.i18nTitle));
  });
}

function wireLocaleSwitcher() {
  if (!el.localeSelect) return;
  el.localeSelect.addEventListener("change", () => setLocale(el.localeSelect.value));
}

/** Reflects the active locale onto the switcher control (so a stored/auto
 * choice shows as selected on load, and a programmatic switch stays in sync). */
function syncLocaleControl() {
  if (el.localeSelect) el.localeSelect.value = getLocale();
}

/** If a prompt was previously generated and hasn't been hand-edited since,
 * regenerates it in the current locale; otherwise leaves the textarea alone so
 * manual edits (or an intentionally blank result) survive the language switch. */
function regeneratePromptIfUnedited() {
  if (state.promptGenerated && el.promptResult.value === state.lastGeneratedPrompt) {
    // Fire-and-forget: generatePrompt is async (it may fetch embed content),
    // and it writes the textarea itself when it resolves.
    generatePrompt();
  }
}

/** Re-renders every locale-dependent surface after the active locale changes:
 * static chrome, the composer selects, all dynamically built lists/panels, and
 * (when safe) the generated prompt. */
function renderAll() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = getLocale();
  applyStaticI18n();
  syncLocaleControl();
  repopulatePromptSelects();
  updatePromptFilenameVisibility();
  updateComposerToggleAria();
  renderTree();
  renderRootBasename();
  renderRecentList();
  renderContentToolbar();
  renderFilePanels();
  regeneratePromptIfUnedited();
}

if (typeof document !== "undefined") {
  el = {
    localeSelect: document.getElementById("locale-select"),
    securityNotice: document.getElementById("security-notice"),
    securityNoticeDismiss: document.getElementById("security-notice-dismiss"),
    securityNoticeCollapsed: document.getElementById("security-notice-collapsed"),
    rootBasename: document.getElementById("root-basename"),
    rootPath: document.getElementById("root-path"),
    treeRoot: document.getElementById("tree-root"),
    treeTruncationWarning: document.getElementById("tree-truncation-warning"),
    searchInput: document.getElementById("search-input"),
    recentList: document.getElementById("recent-list"),
    recentClear: document.getElementById("recent-clear"),
    filePanels: document.getElementById("file-panels"),
    contentEmptyHint: document.getElementById("content-empty-hint"),
    contentToolbarCount: document.getElementById("content-toolbar-count"),
    contentToolbarStats: document.getElementById("content-toolbar-stats"),
    contentToolbarActions: document.getElementById("content-toolbar-actions"),
    explorerPane: document.getElementById("explorer-pane"),
    resizer: document.getElementById("resizer"),
    copyToast: document.getElementById("copy-toast"),
    promptComposerBody: document.getElementById("prompt-composer-body"),
    promptComposerToggle: document.getElementById("prompt-composer-toggle"),
    promptGoal: document.getElementById("prompt-goal"),
    promptTarget: document.getElementById("prompt-target"),
    promptOutput: document.getElementById("prompt-output"),
    promptFilenameField: document.getElementById("prompt-filename-field"),
    promptFilename: document.getElementById("prompt-filename"),
    promptContextMode: document.getElementById("prompt-context-mode"),
    promptExtra: document.getElementById("prompt-extra"),
    promptGenerate: document.getElementById("prompt-generate"),
    promptCopy: document.getElementById("prompt-copy"),
    promptResult: document.getElementById("prompt-result"),
  };

  init();
}
