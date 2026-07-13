import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extensionOf,
  isSourceFile,
  isDocFile,
  ensureNode,
  computeFileDescendants,
  sortedChildren,
  describeCheckboxState,
  computeSearchMatches,
  clamp,
  nextRecentList,
  nextOpenFilesList,
  formatFileRef,
  formatDirRef,
  formatLinesRef,
  parseRef,
  hashFragmentFromRef,
  refFromHashFragment,
  nextLineSelection,
  writeRefToHash,
  languageForPath,
  escapeXmlAttribute,
  escapeXmlText,
  markdownFenceFor,
  formatSingleFile,
  formatMultipleFiles,
  formatFileTree,
  formatReferenceWithCode,
  copyTextToClipboard,
  fetchFileContents,
  formatLabel,
  PROMPT_GOALS,
  PROMPT_TARGETS,
  PROMPT_OUTPUTS,
  PROMPT_CONTEXT_MODES,
  describePromptTarget,
  describePromptOutput,
  buildPromptContextSection,
  buildPromptText,
  describeGitDiff,
  formatInlineCode,
  sliceSelectedLines,
  computeSelectionStats,
  formatWithThousandsSeparator,
  formatSelectionStats,
  tr,
  substituteParams,
  detectInitialLocale,
  loadSecurityNoticeDismissed,
  saveSecurityNoticeDismissed,
  computeSecurityNoticeDomState,
} from "./app.js";

// ---- extensionOf ----

describe("extensionOf", () => {
  test("returns the extension for a normal file", () => {
    assert.equal(extensionOf("src/foo.rs"), "rs");
  });

  test("returns an empty string when there is no dot at all (dotIndex === -1)", () => {
    assert.equal(extensionOf("README"), "");
  });

  test("returns an empty string for a dotfile with only a leading dot (dotIndex === 0)", () => {
    assert.equal(extensionOf(".gitignore"), "");
  });

  test("returns the extension when the dot is the second character (dotIndex === 1)", () => {
    assert.equal(extensionOf("a.b"), "b");
  });

  test("returns the last extension when multiple dots are present", () => {
    assert.equal(extensionOf("archive.tar.gz"), "gz");
  });

  test("considers only the basename when the path includes directory separators", () => {
    assert.equal(extensionOf("src/lib/foo.test.js"), "js");
  });
});

// ---- isSourceFile ----

describe("isSourceFile", () => {
  test("returns true for a known source extension", () => {
    assert.equal(isSourceFile("src/app.js"), true);
  });

  test("returns false for a non-source extension", () => {
    assert.equal(isSourceFile("notes.md"), false);
  });

  test("is case-insensitive for the extension", () => {
    assert.equal(isSourceFile("Main.RS"), true);
  });
});

// ---- isDocFile ----

describe("isDocFile", () => {
  test("returns true for a bare README with no extension", () => {
    assert.equal(isDocFile("README"), true);
  });

  test("returns true for README.rs (name-prefix check ignores the extension; documented quirk)", () => {
    // isDocFile checks `name.startsWith("README")` before ever looking at
    // the extension, so a source file that happens to be named README.rs is
    // classified as a doc. This is the existing, intentional-looking
    // behavior of the name check, not a bug being fixed here.
    assert.equal(isDocFile("README.rs"), true);
  });

  test("returns true for the literal path 'docs' (known: cannot distinguish file from directory, discovery #4)", () => {
    // Known, not fixed here: isDocFile only ever sees a path string, so it
    // cannot tell whether "docs" refers to a directory or a file. See
    // discovery item #4 in the test-design notes; left for review to decide
    // whether callers should pre-filter to files only.
    assert.equal(isDocFile("docs"), true);
  });

  test("returns false for a directory name that merely starts with 'docs' as a substring", () => {
    assert.equal(isDocFile("mydocs"), false);
  });

  test("returns false for a file inside a directory that merely starts with 'docs' as a substring", () => {
    assert.equal(isDocFile("mydocs/file.rs"), false);
  });

  test("returns true for a doc extension regardless of case", () => {
    assert.equal(isDocFile("notes.MD"), true);
  });
});

// ---- Tree construction: ensureNode / computeFileDescendants / sortedChildren ----

describe("ensureNode", () => {
  function newRootMap() {
    const root = {
      path: "",
      name: "",
      isDir: true,
      likelySecret: false,
      children: new Map(),
    };
    return new Map([["", root]]);
  }

  test("implicitly creates intermediate directories that have no explicit entry", () => {
    const nodesByPath = newRootMap();
    ensureNode(nodesByPath, "a/b/c.txt", false, false);

    assert.equal(nodesByPath.get("a").isDir, true);
    assert.equal(nodesByPath.get("a/b").isDir, true);
    assert.equal(nodesByPath.get("a/b/c.txt").isDir, false);
  });

  test("a later explicit entry overwrites an implicitly-created directory's fields", () => {
    const nodesByPath = newRootMap();
    // "a" is only implied here (its isDir/likelySecret come from the
    // implicit-parent defaults inside ensureNode: true/false).
    ensureNode(nodesByPath, "a/b.txt", false, false);
    assert.equal(nodesByPath.get("a").likelySecret, false);

    // A later explicit walk entry for "a" itself should update the same
    // node in place rather than creating a duplicate.
    const updated = ensureNode(nodesByPath, "a", true, true);

    assert.equal(nodesByPath.get("a"), updated);
    assert.equal(updated.likelySecret, true);
  });

  test("same-named files in different directories do not collide", () => {
    const nodesByPath = newRootMap();
    ensureNode(nodesByPath, "src/main.rs", false, false);
    ensureNode(nodesByPath, "lib/main.rs", false, false);

    const srcMain = nodesByPath.get("src/main.rs");
    const libMain = nodesByPath.get("lib/main.rs");

    assert.notEqual(srcMain, libMain);
    assert.equal(srcMain.name, "main.rs");
    assert.equal(libMain.name, "main.rs");
    assert.equal(nodesByPath.get("src").children.get("main.rs"), srcMain);
    assert.equal(nodesByPath.get("lib").children.get("main.rs"), libMain);
  });
});

describe("computeFileDescendants", () => {
  test("returns only file paths, never directory paths", () => {
    const nodesByPath = new Map([
      [
        "",
        {
          path: "",
          name: "",
          isDir: true,
          likelySecret: false,
          children: new Map(),
        },
      ],
    ]);
    const root = nodesByPath.get("");
    ensureNode(nodesByPath, "dir/file.txt", false, false);
    ensureNode(nodesByPath, "dir/subdir/other.txt", false, false);

    const files = computeFileDescendants(root);

    assert.deepEqual(new Set(files), new Set(["dir/file.txt", "dir/subdir/other.txt"]));
    assert.ok(!files.includes("dir"));
    assert.ok(!files.includes("dir/subdir"));
  });

  test("returns an empty array for a directory with zero file descendants", () => {
    const nodesByPath = new Map([
      [
        "",
        {
          path: "",
          name: "",
          isDir: true,
          likelySecret: false,
          children: new Map(),
        },
      ],
    ]);
    const root = nodesByPath.get("");

    const files = computeFileDescendants(root);

    assert.deepEqual(files, []);
  });
});

describe("sortedChildren", () => {
  test("lists directories before files, each alphabetically", () => {
    const node = {
      path: "",
      isDir: true,
      children: new Map([
        ["zebra.txt", { name: "zebra.txt", isDir: false }],
        ["beta", { name: "beta", isDir: true }],
        ["alpha.txt", { name: "alpha.txt", isDir: false }],
        ["gamma", { name: "gamma", isDir: true }],
      ]),
    };

    const names = sortedChildren(node).map((child) => child.name);

    assert.deepEqual(names, ["beta", "gamma", "alpha.txt", "zebra.txt"]);
  });
});

// ---- describeCheckboxState (decision table 1) ----

describe("describeCheckboxState", () => {
  test("row 1: total=0, checkedCount=0 -> not checked, not indeterminate", () => {
    const result = describeCheckboxState([], new Set());
    assert.deepEqual(result, { checked: false, indeterminate: false });
  });

  test("row 2: total>0, checkedCount=0 -> not checked, not indeterminate", () => {
    const result = describeCheckboxState(["a", "b"], new Set());
    assert.deepEqual(result, { checked: false, indeterminate: false });
  });

  test("row 3: total>0, 0<checkedCount<total -> not checked, indeterminate", () => {
    const result = describeCheckboxState(["a", "b"], new Set(["a"]));
    assert.deepEqual(result, { checked: false, indeterminate: true });
  });

  test("row 4: total>0, checkedCount=total -> checked, not indeterminate", () => {
    const result = describeCheckboxState(["a", "b"], new Set(["a", "b"]));
    assert.deepEqual(result, { checked: true, indeterminate: false });
  });
});

// ---- computeSearchMatches ----

describe("computeSearchMatches", () => {
  function buildRoot() {
    const root = {
      path: "",
      name: "",
      isDir: true,
      children: new Map(),
    };
    const nodesByPath = new Map([["", root]]);
    ensureNode(nodesByPath, "src/main.rs", false, false);
    ensureNode(nodesByPath, "src/lib.rs", false, false);
    ensureNode(nodesByPath, "docs/notes.md", false, false);
    return root;
  }

  test("a file matching the query is self-matched, and its ancestor directory is descendant-matched", () => {
    const root = buildRoot();
    const matches = computeSearchMatches(root, "main");

    assert.equal(matches.get("src/main.rs").selfMatches, true);
    assert.equal(matches.get("src").selfMatches, false);
    assert.equal(matches.get("src").descendantMatches, true);
  });

  test("a sibling file that does not match and has no matching descendants is unmatched", () => {
    const root = buildRoot();
    const matches = computeSearchMatches(root, "main");

    assert.equal(matches.get("src/lib.rs").selfMatches, false);
    assert.equal(matches.get("src/lib.rs").descendantMatches, false);
  });

  test("an unrelated directory with no matches anywhere below it is fully unmatched", () => {
    const root = buildRoot();
    const matches = computeSearchMatches(root, "main");

    assert.equal(matches.get("docs").selfMatches, false);
    assert.equal(matches.get("docs").descendantMatches, false);
    assert.equal(matches.get("docs/notes.md").selfMatches, false);
  });

  test("a directory name itself matching the query is self-matched", () => {
    const root = buildRoot();
    const matches = computeSearchMatches(root, "docs");

    assert.equal(matches.get("docs").selfMatches, true);
  });

  test("a query matching nothing produces no matched entries", () => {
    const root = buildRoot();
    const matches = computeSearchMatches(root, "nope-does-not-exist");

    for (const [path, match] of matches) {
      assert.equal(match.selfMatches, false, `expected ${path} to not self-match`);
      assert.equal(match.descendantMatches, false, `expected ${path} to have no matching descendants`);
    }
  });
});

// ---- clamp ----

describe("clamp", () => {
  const MIN = 220;
  const MAX = 800;

  test("clamps a value one below the minimum up to the minimum", () => {
    assert.equal(clamp(MIN - 1, MIN, MAX), MIN);
  });

  test("passes through a value exactly at the minimum", () => {
    assert.equal(clamp(MIN, MIN, MAX), MIN);
  });

  test("passes through a value one above the minimum unclamped", () => {
    assert.equal(clamp(MIN + 1, MIN, MAX), MIN + 1);
  });

  test("passes through a value one below the maximum unclamped", () => {
    assert.equal(clamp(MAX - 1, MIN, MAX), MAX - 1);
  });

  test("passes through a value exactly at the maximum", () => {
    assert.equal(clamp(MAX, MIN, MAX), MAX);
  });

  test("clamps a value one above the maximum down to the maximum", () => {
    assert.equal(clamp(MAX + 1, MIN, MAX), MAX);
  });
});

// ---- nextRecentList ----

describe("nextRecentList", () => {
  test("adds a single entry to an empty list", () => {
    assert.deepEqual(nextRecentList([], "a.txt", 100), ["a.txt"]);
  });

  test("re-adding the item already at the front is idempotent", () => {
    assert.deepEqual(nextRecentList(["a.txt", "b.txt"], "a.txt", 100), ["a.txt", "b.txt"]);
  });

  test("re-adding an item not at the front moves it to the front without duplicating it", () => {
    assert.deepEqual(nextRecentList(["a.txt", "b.txt", "c.txt"], "c.txt", 100), [
      "c.txt",
      "a.txt",
      "b.txt",
    ]);
  });

  test("growing from 99 to 100 entries keeps every existing entry", () => {
    const list99 = Array.from({ length: 99 }, (_, i) => `file-${i}.txt`);

    const result = nextRecentList(list99, "new.txt", 100);

    assert.equal(result.length, 100);
    assert.equal(result[0], "new.txt");
    for (const path of list99) {
      assert.ok(result.includes(path), `expected ${path} to survive the append`);
    }
  });

  test("re-adding an existing entry at a full 100-entry list reorders but does not drop anything", () => {
    const list100 = Array.from({ length: 100 }, (_, i) => `file-${i}.txt`);

    const result = nextRecentList(list100, "file-50.txt", 100);

    assert.equal(result.length, 100);
    assert.equal(result[0], "file-50.txt");
    for (const path of list100) {
      assert.ok(result.includes(path), `expected ${path} to survive the reorder`);
    }
  });

  test("adding a brand-new entry to a full 100-entry list drops exactly the oldest one", () => {
    const list100 = Array.from({ length: 100 }, (_, i) => `file-${i}.txt`);

    const result = nextRecentList(list100, "new.txt", 100);

    assert.equal(result.length, 100);
    assert.equal(result[0], "new.txt");
    assert.ok(!result.includes("file-99.txt"), "the oldest (last) entry should be dropped");
    for (let i = 0; i < 99; i++) {
      assert.ok(result.includes(`file-${i}.txt`), `expected file-${i}.txt to survive`);
    }
  });
});

// ---- nextOpenFilesList ----

describe("nextOpenFilesList", () => {
  test("adds a single entry to an empty list", () => {
    assert.deepEqual(nextOpenFilesList([], "a.txt"), ["a.txt"]);
  });

  test("a new entry that sorts before existing entries is inserted at the front, not appended", () => {
    assert.deepEqual(nextOpenFilesList(["b.txt", "c.txt"], "a.txt"), [
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
  });

  test("re-adding an entry already present is idempotent (no duplicate)", () => {
    assert.deepEqual(nextOpenFilesList(["a.txt", "b.txt"], "a.txt"), ["a.txt", "b.txt"]);
  });

  test("checking files in reverse-alphabetical order still ends up in path order", () => {
    let openFiles = [];
    for (const path of ["c.txt", "b.txt", "a.txt"]) {
      openFiles = nextOpenFilesList(openFiles, path);
    }

    assert.deepEqual(openFiles, ["a.txt", "b.txt", "c.txt"]);
  });

  test("closing a file then re-checking it returns it to its tree-order slot, not the end", () => {
    const opened = ["a.txt", "b.txt", "c.txt"];
    const afterClose = opened.filter((p) => p !== "b.txt");

    const reopened = nextOpenFilesList(afterClose, "b.txt");

    assert.deepEqual(reopened, ["a.txt", "b.txt", "c.txt"]);
  });
});

// ---- formatFileRef / formatDirRef ----

describe("formatFileRef / formatDirRef", () => {
  test("formatFileRef returns '@file:<path>' for a normal path", () => {
    assert.equal(formatFileRef("src/app.js"), "@file:src/app.js");
  });

  test("formatDirRef returns '@dir:<path>' for a normal path", () => {
    assert.equal(formatDirRef("src"), "@dir:src");
  });

  test("a path that itself starts with '@' does not collide with the prefix", () => {
    assert.equal(formatFileRef("@types/foo.ts"), "@file:@types/foo.ts");
    assert.equal(formatDirRef("@types"), "@dir:@types");
  });
});

// ---- formatLinesRef ----

describe("formatLinesRef", () => {
  test("start === end produces the single-line '#L<n>' form", () => {
    assert.equal(formatLinesRef("a.js", 5, 5), "@lines:a.js#L5");
  });

  test("start < end produces the '#L<start>-L<end>' form", () => {
    assert.equal(formatLinesRef("a.js", 5, 10), "@lines:a.js#L5-L10");
  });

  test("start > end is normalized to '#L<min>-L<max>' in the output", () => {
    assert.equal(formatLinesRef("a.js", 10, 5), "@lines:a.js#L5-L10");
  });

  test("omitting end formats a single line equal to start", () => {
    assert.equal(formatLinesRef("a.js", 5), "@lines:a.js#L5");
  });

  test("passing end explicitly equal to start matches the output of omitting end", () => {
    assert.equal(formatLinesRef("a.js", 5, 5), formatLinesRef("a.js", 5));
  });

  test("a start of 0 is clamped to 1, matching parseRef's own lower bound", () => {
    assert.equal(formatLinesRef("a.js", 0, 5), "@lines:a.js#L1-L5");
  });

  test("a negative start is clamped to 1", () => {
    assert.equal(formatLinesRef("a.js", -3, 5), "@lines:a.js#L1-L5");
  });

  test("both endpoints below 1 clamp to a single-line '#L1' form, never '#L0' or negative", () => {
    assert.equal(formatLinesRef("a.js", -3, 0), "@lines:a.js#L1");
  });

  test("every clamped output round-trips through parseRef (the invariant this fix restores)", () => {
    assert.deepEqual(parseRef(formatLinesRef("a.js", 0, 0)), { kind: "lines", path: "a.js", start: 1, end: 1 });
    assert.deepEqual(parseRef(formatLinesRef("a.js", -5, -1)), { kind: "lines", path: "a.js", start: 1, end: 1 });
  });
});

// ---- parseRef: normal cases ----

describe("parseRef - normal cases", () => {
  test("parses '@file:<path>'", () => {
    assert.deepEqual(parseRef("@file:src/app.js"), { kind: "file", path: "src/app.js" });
  });

  test("parses '@dir:<path>'", () => {
    assert.deepEqual(parseRef("@dir:src"), { kind: "dir", path: "src" });
  });

  test("parses '@lines:<path>#L<n>' as a single-line range", () => {
    assert.deepEqual(parseRef("@lines:src/app.js#L5"), {
      kind: "lines",
      path: "src/app.js",
      start: 5,
      end: 5,
    });
  });

  test("parses '@lines:<path>#L<a>-L<b>' with a < b", () => {
    assert.deepEqual(parseRef("@lines:src/app.js#L5-L10"), {
      kind: "lines",
      path: "src/app.js",
      start: 5,
      end: 10,
    });
  });
});

// ---- parseRef: boundary values and reversed ranges ----

describe("parseRef - boundary values and reversed ranges", () => {
  test("'#L0' is rejected as out of range (boundary - 1)", () => {
    assert.equal(parseRef("@lines:a.js#L0"), null);
  });

  test("'#L1' is accepted (boundary)", () => {
    assert.deepEqual(parseRef("@lines:a.js#L1"), { kind: "lines", path: "a.js", start: 1, end: 1 });
  });

  test("'#L2' is accepted (boundary + 1)", () => {
    assert.deepEqual(parseRef("@lines:a.js#L2"), { kind: "lines", path: "a.js", start: 2, end: 2 });
  });

  test("'#L1-L0' is rejected because the end of the range is 0", () => {
    assert.equal(parseRef("@lines:a.js#L1-L0"), null);
  });

  test("'#L0-L5' is rejected because the start of the range is 0", () => {
    assert.equal(parseRef("@lines:a.js#L0-L5"), null);
  });

  test("a reversed range '#L57-L42' is normalized to start=42/end=57", () => {
    assert.deepEqual(parseRef("@lines:a.js#L57-L42"), {
      kind: "lines",
      path: "a.js",
      start: 42,
      end: 57,
    });
  });
});

// ---- parseRef: abnormal input ----

describe("parseRef - abnormal input", () => {
  test("an empty string is rejected", () => {
    assert.equal(parseRef(""), null);
  });

  test("a bare '@' with nothing after it is rejected", () => {
    assert.equal(parseRef("@"), null);
  });

  test("an unrelated string with no ref syntax at all is rejected", () => {
    assert.equal(parseRef("hello world"), null);
  });

  test("an unknown prefix is rejected", () => {
    assert.equal(parseRef("@foo:bar"), null);
  });

  test("'@file:' with an empty path is rejected", () => {
    assert.equal(parseRef("@file:"), null);
  });

  test("'@dir:' with an empty path is rejected", () => {
    assert.equal(parseRef("@dir:"), null);
  });

  test("'@lines:' with nothing after it is rejected", () => {
    assert.equal(parseRef("@lines:"), null);
  });

  test("'@lines:<path>' with no '#' at all is rejected", () => {
    assert.equal(parseRef("@lines:src/app.js"), null);
  });

  test("'@lines:#L5' with an empty path is rejected", () => {
    assert.equal(parseRef("@lines:#L5"), null);
  });

  test("'@lines:<path>#L' with no digits after 'L' is rejected", () => {
    assert.equal(parseRef("@lines:src/app.js#L"), null);
  });

  test("'@lines:<path>#5' missing the 'L' prefix is rejected", () => {
    assert.equal(parseRef("@lines:src/app.js#5"), null);
  });

  test("'@lines:<path>#l5' with a lowercase 'l' is rejected", () => {
    assert.equal(parseRef("@lines:src/app.js#l5"), null);
  });

  test("'@lines:<path>#L5-L3-L2' with an extra range segment is rejected", () => {
    assert.equal(parseRef("@lines:src/app.js#L5-L3-L2"), null);
  });

  test("null does not throw and returns null", () => {
    assert.equal(parseRef(null), null);
  });

  test("undefined does not throw and returns null", () => {
    assert.equal(parseRef(undefined), null);
  });

  test("a number does not throw and returns null", () => {
    assert.equal(parseRef(42), null);
  });

  test("a plain object does not throw and returns null", () => {
    assert.equal(parseRef({}), null);
  });
});

// ---- parseRef: paths containing '#' (lastIndexOf fix) ----

describe("parseRef - paths containing '#'", () => {
  test("a path containing '#' round-trips through formatLinesRef/parseRef after the lastIndexOf fix", () => {
    // Before the fix, `parseRef` split on the *first* "#" (`rest.indexOf`),
    // which mistook the "#" inside the path itself for the range-suffix
    // separator and returned null for this exact input. Splitting on the
    // *last* "#" (`rest.lastIndexOf`) fixes the common case of a single "#"
    // occurring earlier in the path.
    const ref = formatLinesRef("notes#1.md", 5, 5);
    assert.deepEqual(parseRef(ref), { kind: "lines", path: "notes#1.md", start: 5, end: 5 });
  });
});

// ---- hashFragmentFromRef / refFromHashFragment: round trip ----

describe("hashFragmentFromRef / refFromHashFragment - round trip", () => {
  test("round-trips an ASCII path", () => {
    const ref = formatFileRef("src/app.js");
    assert.deepEqual(refFromHashFragment(hashFragmentFromRef(ref)), parseRef(ref));
  });

  test("round-trips a Japanese file name", () => {
    const ref = formatFileRef("資料/計画.md");
    assert.deepEqual(refFromHashFragment(hashFragmentFromRef(ref)), parseRef(ref));
  });

  test("round-trips a path containing spaces", () => {
    const ref = formatFileRef("my folder/a b.txt");
    assert.deepEqual(refFromHashFragment(hashFragmentFromRef(ref)), parseRef(ref));
  });

  test("round-trips a path containing emoji", () => {
    const ref = formatFileRef("📁docs/📄note.md");
    assert.deepEqual(refFromHashFragment(hashFragmentFromRef(ref)), parseRef(ref));
  });

  test("round-trips a path starting with '@' without the '@' being mangled by double encode/decode", () => {
    const ref = formatFileRef("@types/foo.ts");
    assert.deepEqual(refFromHashFragment(hashFragmentFromRef(ref)), parseRef(ref));
  });
});

// ---- refFromHashFragment: abnormal input ----

describe("refFromHashFragment - abnormal input", () => {
  test("an empty string is rejected", () => {
    assert.equal(refFromHashFragment(""), null);
  });

  test("null is rejected", () => {
    assert.equal(refFromHashFragment(null), null);
  });

  test("undefined is rejected", () => {
    assert.equal(refFromHashFragment(undefined), null);
  });

  test("a lone '%' (malformed percent-encoding) does not throw and returns null", () => {
    assert.equal(refFromHashFragment("%"), null);
  });

  test("'%zz' (invalid hex digits) does not throw and returns null", () => {
    assert.equal(refFromHashFragment("%zz"), null);
  });

  test("an incomplete UTF-8 byte sequence ('%E0%A4') does not throw and returns null", () => {
    assert.equal(refFromHashFragment("%E0%A4"), null);
  });

  test("a fragment that decodes cleanly but isn't a known ref format returns null", () => {
    assert.equal(refFromHashFragment(encodeURIComponent("hello world")), null);
  });
});

// ---- nextLineSelection ----

describe("nextLineSelection", () => {
  test("a plain click with no prior selection starts a single-line selection", () => {
    assert.deepEqual(nextLineSelection(undefined, 5, false), { anchor: 5, start: 5, end: 5 });
  });

  test("a Shift-click with no prior selection falls back to a single-line selection (no anchor to extend from)", () => {
    assert.deepEqual(nextLineSelection(undefined, 5, true), { anchor: 5, start: 5, end: 5 });
  });

  test("a plain click with an existing selection resets to a new single-line selection at the clicked line", () => {
    const current = { anchor: 3, start: 3, end: 3 };
    assert.deepEqual(nextLineSelection(current, 7, false), { anchor: 7, start: 7, end: 7 });
  });

  test("Shift-click below the anchor extends the range downward", () => {
    const current = { anchor: 5, start: 5, end: 5 };
    assert.deepEqual(nextLineSelection(current, 10, true), { anchor: 5, start: 5, end: 10 });
  });

  test("Shift-click above the anchor extends the range upward (min/max normalization)", () => {
    const current = { anchor: 5, start: 5, end: 10 };
    assert.deepEqual(nextLineSelection(current, 2, true), { anchor: 5, start: 2, end: 5 });
  });

  test("repeated Shift-clicks are always measured from the original anchor, not the previous start/end", () => {
    const first = nextLineSelection({ anchor: 5, start: 5, end: 5 }, 10, true);
    assert.deepEqual(first, { anchor: 5, start: 5, end: 10 });

    // If this were (incorrectly) measured from `first`'s start/end instead
    // of its anchor, extending to line 2 from a current range of 5-10 could
    // be mistaken for extending from 10. It must still anchor on 5.
    const second = nextLineSelection(first, 2, true);
    assert.deepEqual(second, { anchor: 5, start: 2, end: 5 });
  });
});

// ---- writeRefToHash ----
//
// `setLineSelection` used to assign `window.location.hash` directly, which
// fires a `hashchange` event and re-enters the app's own navigation handler
// on every single line click (a self-triggered scroll+flash loop). It must
// use `window.history.replaceState` instead, which updates the URL without
// firing `hashchange`. `writeRefToHash` isolates that one statement so it
// can be verified here without needing a DOM: stub `window.history
// .replaceState` and check the call, then restore the previous `window`.

describe("writeRefToHash", () => {
  test("calls window.history.replaceState (not a window.location.hash assignment) with the percent-encoded ref as the new URL fragment, without pushing a new history entry", () => {
    const calls = [];
    const originalWindow = global.window;
    global.window = {
      history: {
        replaceState: (...args) => calls.push(args),
      },
    };

    try {
      writeRefToHash("@lines:src/app.js#L5-L10");
    } finally {
      global.window = originalWindow;
    }

    assert.equal(calls.length, 1);
    // First arg `null` (no associated state object) and second arg `""`
    // (unused legacy title parameter) are `replaceState`'s own signature;
    // the third arg is the URL this call actually changes.
    assert.deepEqual(calls[0], [null, "", `#${encodeURIComponent("@lines:src/app.js#L5-L10")}`]);
  });

  test("round-trips through refFromHashFragment back to the original ref", () => {
    let written = null;
    const originalWindow = global.window;
    global.window = {
      history: {
        replaceState: (_state, _title, url) => {
          written = url;
        },
      },
    };

    try {
      writeRefToHash("@lines:notes#1.md#L3");
    } finally {
      global.window = originalWindow;
    }

    assert.deepEqual(refFromHashFragment(written.slice(1)), {
      kind: "lines",
      path: "notes#1.md",
      start: 3,
      end: 3,
    });
  });
});

// ---- languageForPath ----

describe("languageForPath", () => {
  test("resolves a known extension to its Markdown language tag", () => {
    assert.equal(languageForPath("src/app.rs"), "rust");
  });

  test("returns an empty string for an unknown extension", () => {
    assert.equal(languageForPath("data.xyz"), "");
  });

  test("returns an empty string for a file with no extension", () => {
    assert.equal(languageForPath("README"), "");
  });

  test("resolves an uppercase extension case-insensitively", () => {
    assert.equal(languageForPath("FOO.RS"), "rust");
  });
});

// ---- escapeXmlText / escapeXmlAttribute ----

describe("escapeXmlText", () => {
  test("escapes a lone '&' to '&amp;'", () => {
    assert.equal(escapeXmlText("&"), "&amp;");
  });

  test("escapes a lone '<' to '&lt;'", () => {
    assert.equal(escapeXmlText("<"), "&lt;");
  });

  test("escapes a lone '>' to '&gt;'", () => {
    assert.equal(escapeXmlText(">"), "&gt;");
  });

  test("re-escapes an input that already looks like the entity '&amp;', producing '&amp;amp;' (double escaping is intended)", () => {
    // The input here is raw file content, not a stream of already-encoded XML
    // entities: there is no basis for assuming a literal "&amp;" appearing in
    // some file's text was already meant as an entity, so re-escaping its "&"
    // is the correct, intended behavior -- not a bug to fix.
    assert.equal(escapeXmlText("&amp;"), "&amp;amp;");
  });

  test("passes non-ASCII text (Japanese, emoji) through unchanged", () => {
    assert.equal(escapeXmlText("日本語😀"), "日本語😀");
  });

  test("returns an empty string for an empty string", () => {
    assert.equal(escapeXmlText(""), "");
  });
});

describe("escapeXmlAttribute", () => {
  test("escapes a lone '\"' to '&quot;' (the one character escapeXmlText does not need to handle)", () => {
    assert.equal(escapeXmlAttribute('"'), "&quot;");
  });

  test("escapes all four special characters in one string, in the correct order, without re-escaping its own generated entities", () => {
    // "&" must be replaced first: escaping "<"/">"/"\"" all produce entities
    // that start with "&", so escaping "&" afterward would double-escape
    // them. This asserts the actual combined output, which only comes out
    // correct if the replacements run in that order.
    assert.equal(escapeXmlAttribute(`&<>"`), "&amp;&lt;&gt;&quot;");
  });
});

// ---- markdownFenceFor ----

describe("markdownFenceFor", () => {
  test("content with no backticks at all uses the minimum 3-backtick fence", () => {
    assert.equal(markdownFenceFor("plain content"), "```");
  });

  test("non-consecutive single backticks (longest run is still 1) keep the 3-backtick fence", () => {
    // Confirms the function looks at the longest *consecutive* run, not just
    // whether a backtick appears anywhere in the content.
    assert.equal(markdownFenceFor("a ` b ` c"), "```");
  });

  test("a run of 3 consecutive backticks escalates the fence to 4 backticks", () => {
    assert.equal(markdownFenceFor("before ``` after"), "````");
  });

  test("a run of 4 consecutive backticks escalates the fence to 5 backticks", () => {
    assert.equal(markdownFenceFor("````"), "`````");
  });

  test("multiple runs of different lengths escalate based on the longest run, not the sum of all runs", () => {
    // Two separate runs of length 2 and length 4. Summing them would
    // (incorrectly) reach 6 and escalate to a 7-backtick fence; taking the
    // max correctly escalates to only 5.
    assert.equal(markdownFenceFor("`` middle ````"), "`````");
  });
});

// ---- formatInlineCode ----

describe("formatInlineCode", () => {
  test("wraps plain text with a single backtick on each side", () => {
    assert.equal(formatInlineCode("output.md"), "`output.md`");
  });

  test("escalates to a double backtick when the text contains an internal single backtick", () => {
    // A bare "`out`put.md`" would prematurely close after "out"; escalating
    // to a 2-backtick fence prevents that. No padding is needed here since
    // the backtick isn't at either boundary.
    assert.equal(formatInlineCode("out`put.md"), "``out`put.md``");
  });

  test("pads a leading/trailing backtick even when no fence escalation is otherwise needed", () => {
    assert.equal(formatInlineCode("`leading"), "`` `leading ``");
    assert.equal(formatInlineCode("trailing`"), "`` trailing` ``");
  });

  test("escalates based on the longest consecutive internal run, matching markdownFenceFor's rule", () => {
    assert.equal(formatInlineCode("a``b"), "```a``b```");
  });
});

// ---- sliceSelectedLines ----

describe("sliceSelectedLines", () => {
  test("returns the single requested line for start === end", () => {
    assert.equal(sliceSelectedLines("a\nb\nc\n", 2, 2), "b");
  });

  test("returns an inclusive multi-line range", () => {
    assert.equal(sliceSelectedLines("a\nb\nc\nd\n", 2, 3), "b\nc");
  });

  test("drops a trailing empty line from a final newline before slicing", () => {
    // Without dropping it, "a\nb\n".split("\n") is ["a", "b", ""] and a
    // range covering the last real line would still work here, but the line
    // *count* would be wrong by one -- this is the same rule buildCodeLines
    // uses for its displayed line numbers, so a selection's line numbers and
    // this slice have to agree on what "line 2" means.
    assert.equal(sliceSelectedLines("a\nb\n", 1, 2), "a\nb");
  });

  test("handles content with no trailing newline the same way", () => {
    assert.equal(sliceSelectedLines("a\nb\nc", 1, 3), "a\nb\nc");
  });
});

// ---- Selection size statistics (issue #8) ----

describe("computeSelectionStats", () => {
  test("returns all zeros for an empty selection", () => {
    const stats = computeSelectionStats([], new Map());
    assert.deepEqual(stats, {
      fileCount: 0,
      pendingCount: 0,
      charCount: 0,
      estimatedTokens: 0,
      isLarge: false,
    });
  });

  test("sums character counts across every checked path with cached content", () => {
    const cache = new Map([
      ["a.js", "1234"],
      ["b.js", "12345678"],
    ]);
    const stats = computeSelectionStats(["a.js", "b.js"], cache);
    assert.equal(stats.fileCount, 2);
    assert.equal(stats.pendingCount, 0);
    assert.equal(stats.charCount, 12);
  });

  test("counts a checked path with no cache entry yet as pending, not zero characters", () => {
    const cache = new Map([["a.js", "1234"]]);
    const stats = computeSelectionStats(["a.js", "still-loading.js"], cache);
    assert.equal(stats.fileCount, 2);
    assert.equal(stats.pendingCount, 1);
    assert.equal(stats.charCount, 4);
  });

  test("rounds the estimated token count up, never truncating a partial token to zero", () => {
    const stats = computeSelectionStats(["a.js"], new Map([["a.js", "12345"]]));
    // 5 characters / 4 chars-per-token = 1.25 -> should round up to 2, not
    // truncate down to 1.
    assert.equal(stats.estimatedTokens, 2);
  });

  test("flags isLarge only once character count exceeds the threshold", () => {
    const justUnder = computeSelectionStats(["a.js"], new Map([["a.js", "x".repeat(200_000)]]));
    assert.equal(justUnder.isLarge, false);

    const over = computeSelectionStats(["a.js"], new Map([["a.js", "x".repeat(200_001)]]));
    assert.equal(over.isLarge, true);
  });
});

describe("formatWithThousandsSeparator", () => {
  test("leaves a number under 1000 unchanged", () => {
    assert.equal(formatWithThousandsSeparator(42), "42");
  });

  test("inserts a comma every three digits", () => {
    assert.equal(formatWithThousandsSeparator(1234567), "1,234,567");
  });

  test("handles exactly three digits with no leading comma", () => {
    assert.equal(formatWithThousandsSeparator(999), "999");
    assert.equal(formatWithThousandsSeparator(1000), "1,000");
  });

  test("handles zero", () => {
    assert.equal(formatWithThousandsSeparator(0), "0");
  });
});

describe("formatSelectionStats", () => {
  test("reports 'No files selected.' for an empty selection", () => {
    const stats = computeSelectionStats([], new Map());
    assert.equal(formatSelectionStats(stats), "No files selected.");
  });

  test("uses singular phrasing for exactly one file", () => {
    const stats = computeSelectionStats(["a.js"], new Map([["a.js", "abcd"]]));
    assert.match(formatSelectionStats(stats), /^1 file selected/);
  });

  test("uses plural phrasing for more than one file", () => {
    const stats = computeSelectionStats(
      ["a.js", "b.js"],
      new Map([
        ["a.js", "ab"],
        ["b.js", "cd"],
      ])
    );
    assert.match(formatSelectionStats(stats), /^2 files selected/);
  });

  test("notes a pending count when some checked files haven't loaded yet", () => {
    const stats = computeSelectionStats(["a.js", "b.js"], new Map([["a.js", "abcd"]]));
    assert.match(formatSelectionStats(stats), /\(1 still loading\)/);
  });

  test("omits the pending note once every checked file has loaded", () => {
    const stats = computeSelectionStats(["a.js"], new Map([["a.js", "abcd"]]));
    assert.doesNotMatch(formatSelectionStats(stats), /still loading/);
  });

  test("includes a large-selection warning only when isLarge is true", () => {
    const small = computeSelectionStats(["a.js"], new Map([["a.js", "abcd"]]));
    assert.doesNotMatch(formatSelectionStats(small), /large selection/);

    const large = computeSelectionStats(["a.js"], new Map([["a.js", "x".repeat(200_001)]]));
    assert.match(formatSelectionStats(large), /⚠ large selection$/);
  });
});

// ---- formatSingleFile ----

describe("formatSingleFile", () => {
  test("'plain' renders a path heading, a matching underline, and the content verbatim", () => {
    assert.equal(
      formatSingleFile("src/app.js", "console.log(1);", "plain"),
      "src/app.js\n----------\nconsole.log(1);"
    );
  });

  test("'markdown' opens the fence with the language tag for a known extension", () => {
    assert.equal(
      formatSingleFile("src/app.rs", "fn main() {}", "markdown"),
      "### src/app.rs\n\n```rust\nfn main() {}\n```\n"
    );
  });

  test("'markdown' opens the fence with no language tag for an unknown extension", () => {
    assert.equal(formatSingleFile("data.xyz", "abc", "markdown"), "### data.xyz\n\n```\nabc\n```\n");
  });

  test("'markdown' with empty content still renders a well-formed (empty-body) fenced block", () => {
    assert.equal(formatSingleFile("empty.txt", "", "markdown"), "### empty.txt\n\n```\n\n```\n");
  });

  test("'xml' escapes the path and the content independently, each in its own escaping rules", () => {
    assert.equal(
      formatSingleFile('weird"path.txt', "a < b", "xml"),
      '<file path="weird&quot;path.txt">a &lt; b</file>'
    );
  });

  test("'diff' is byte-identical to 'plain' (regression guard: issue #8 will feed real diff content through this slot, but for now it's just a placeholder for 'plain')", () => {
    const path = "src/app.js";
    const content = "console.log(1);";
    assert.equal(formatSingleFile(path, content, "diff"), formatSingleFile(path, content, "plain"));
  });

  test("an unrecognized format string falls back to 'plain'", () => {
    const path = "src/app.js";
    const content = "console.log(1);";
    assert.equal(formatSingleFile(path, content, "bogus"), formatSingleFile(path, content, "plain"));
  });

  test("format === undefined falls back to 'plain'", () => {
    const path = "src/app.js";
    const content = "console.log(1);";
    assert.equal(formatSingleFile(path, content, undefined), formatSingleFile(path, content, "plain"));
  });

  test("format === null or a number both fall back to 'plain'", () => {
    const path = "src/app.js";
    const content = "console.log(1);";
    assert.equal(formatSingleFile(path, content, null), formatSingleFile(path, content, "plain"));
    assert.equal(formatSingleFile(path, content, 42), formatSingleFile(path, content, "plain"));
  });

  test("boundary: an empty path still gets the minimum 3-dash underline", () => {
    assert.equal(formatSingleFile("", "x", "plain"), "\n---\nx");
  });

  test("boundary: a 3-character path gets an underline of exactly 3 dashes", () => {
    assert.equal(formatSingleFile("abc", "x", "plain"), "abc\n---\nx");
  });

  test("boundary + 1: a 4-character path gets an underline of exactly 4 dashes", () => {
    assert.equal(formatSingleFile("abcd", "x", "plain"), "abcd\n----\nx");
  });
});

// ---- formatMultipleFiles ----

describe("formatMultipleFiles", () => {
  const entries = [
    { path: "b.txt", content: "B content" },
    { path: "a.txt", content: "A content" },
  ];

  test("'plain' joins each file's plain block, sorted by path ascending, separated by a blank line", () => {
    assert.equal(
      formatMultipleFiles(entries, "plain"),
      "a.txt\n-----\nA content\n\nb.txt\n-----\nB content"
    );
  });

  test("'markdown' joins each file's markdown block, sorted by path ascending, with a single-newline joiner", () => {
    assert.equal(
      formatMultipleFiles(entries, "markdown"),
      "### a.txt\n\n```\nA content\n```\n\n### b.txt\n\n```\nB content\n```\n"
    );
  });

  test("'xml' wraps every sorted <file> element inside a single <files> element", () => {
    assert.equal(
      formatMultipleFiles(entries, "xml"),
      '<files>\n<file path="a.txt">A content</file>\n<file path="b.txt">B content</file>\n</files>'
    );
  });

  test("'diff' joins entries the same way 'plain' does", () => {
    assert.equal(formatMultipleFiles(entries, "diff"), formatMultipleFiles(entries, "plain"));
  });

  test("an empty entries array produces an empty string for 'plain' and 'markdown'", () => {
    assert.equal(formatMultipleFiles([], "plain"), "");
    assert.equal(formatMultipleFiles([], "markdown"), "");
  });

  test("an empty entries array still produces a well-formed empty <files> element for 'xml'", () => {
    assert.equal(formatMultipleFiles([], "xml"), "<files>\n\n</files>");
  });

  test("a single-element entries array is still wrapped by exactly one <files> element in 'xml'", () => {
    const single = [{ path: "only.txt", content: "content" }];
    assert.equal(
      formatMultipleFiles(single, "xml"),
      '<files>\n<file path="only.txt">content</file>\n</files>'
    );
  });

  test("output is deterministic: reordering the input entries produces byte-identical output (always sorted by path)", () => {
    const forward = formatMultipleFiles(entries, "markdown");
    const reversed = formatMultipleFiles([...entries].reverse(), "markdown");
    assert.equal(forward, reversed);
  });

  test("duplicate paths are not deduplicated: both entries survive, in their original relative order", () => {
    // formatMultipleFiles only ever sorts by `path`, and Array.prototype.sort
    // is stable, so two entries sharing the same path keep their original
    // relative order rather than being merged or having one silently
    // dropped. This is the documented, intended behavior -- callers in this
    // app never actually produce duplicate paths, so there's no dedupe logic
    // to fall back on if they did.
    const duplicatePathEntries = [
      { path: "dup.txt", content: "first" },
      { path: "dup.txt", content: "second" },
    ];
    assert.equal(
      formatMultipleFiles(duplicatePathEntries, "plain"),
      "dup.txt\n-------\nfirst\n\ndup.txt\n-------\nsecond"
    );
  });

  test("i18n: multiple entries with Japanese file names concatenate without corruption", () => {
    const jaEntries = [
      { path: "資料/計画.md", content: "計画の内容" },
      { path: "資料/メモ.txt", content: "メモの内容" },
    ];
    assert.equal(
      formatMultipleFiles(jaEntries, "plain"),
      "資料/メモ.txt\n---------\nメモの内容\n\n資料/計画.md\n--------\n計画の内容"
    );
  });
});

// ---- formatFileTree ----

describe("formatFileTree", () => {
  test("'plain' lists flat files one per line, alphabetically", () => {
    assert.equal(formatFileTree(["file2.txt", "file1.txt"], "plain"), "file1.txt\nfile2.txt");
  });

  test("indentation grows proportionally with nesting depth (3+ levels deep)", () => {
    assert.equal(formatFileTree(["a/b/c/deep.txt"], "plain"), "a/\n  b/\n    c/\n      deep.txt");
  });

  test("the same file name at different directory levels renders as two separate branches, not one shared node", () => {
    assert.equal(formatFileTree(["src/util.rs", "lib/util.rs"], "plain"), "lib/\n  util.rs\nsrc/\n  util.rs");
  });

  test("an empty paths array produces an empty string for 'plain'", () => {
    assert.equal(formatFileTree([], "plain"), "");
  });

  test("an empty paths array still produces a well-formed empty <tree> element for 'xml'", () => {
    assert.equal(formatFileTree([], "xml"), "<tree>\n\n</tree>");
  });

  test("'xml' is a flat list of <file> elements even for nested paths -- directories are never nested as XML elements", () => {
    assert.equal(
      formatFileTree(["a/b/c.txt", "d.txt"], "xml"),
      '<tree>\n<file path="a/b/c.txt"/>\n<file path="d.txt"/>\n</tree>'
    );
  });

  test("'markdown' wraps the whole listing in a single fenced code block", () => {
    assert.equal(formatFileTree(["a.txt", "b.txt"], "markdown"), "```\na.txt\nb.txt\n```");
  });

  test("'diff' is identical to 'plain' (a tree listing has no diff-specific shape)", () => {
    const paths = ["a/b.txt", "c.txt"];
    assert.equal(formatFileTree(paths, "diff"), formatFileTree(paths, "plain"));
  });

  test("an unrecognized format falls back to the same output as 'plain'", () => {
    const paths = ["a/b.txt", "c.txt"];
    assert.equal(formatFileTree(paths, "bogus"), formatFileTree(paths, "plain"));
  });

  test("current-behavior fixation: a path that is both a leaf ('a/b') and, via another entry ('a/b/c'), a directory -- pins down what the function actually does today", () => {
    // `/api/tree` never produces this contradiction in practice (a real
    // filesystem entry is either a file or a directory, never both, so this
    // input is unreachable in production). `buildPathTree` has no explicit
    // handling for it: "b" ends up with a child ("c"), so it is rendered
    // purely as a directory -- the "a/b" leaf's own existence is silently
    // absorbed rather than appearing as its own line. This test only records
    // that current behavior so a future refactor doesn't change it silently;
    // it isn't a bug being fixed here.
    assert.equal(formatFileTree(["a/b", "a/b/c"], "plain"), "a/\n  b/\n    c");
  });
});

// ---- formatReferenceWithCode ----

describe("formatReferenceWithCode", () => {
  test("'markdown' opens the fence with the language tag inferred from an '@file:' ref's embedded path", () => {
    const ref = formatFileRef("src/app.rs");
    assert.equal(
      formatReferenceWithCode(ref, "fn main() {}", "markdown"),
      `### ${ref}\n\n\`\`\`rust\nfn main() {}\n\`\`\`\n`
    );
  });

  test("'markdown' falls back to no language tag when the ref string doesn't parse (parseRef returns null)", () => {
    const ref = "not-a-real-ref";
    assert.equal(
      formatReferenceWithCode(ref, "some code", "markdown"),
      `### ${ref}\n\n\`\`\`\nsome code\n\`\`\`\n`
    );
  });

  test("'xml' escapes the ref as an XML attribute and the content as XML text, each independently", () => {
    const ref = formatFileRef('weird"path.rs');
    assert.equal(
      formatReferenceWithCode(ref, "a < b", "xml"),
      '<file ref="@file:weird&quot;path.rs">a &lt; b</file>'
    );
  });

  test("'diff' and 'plain' both render the exact same '<ref>\\n<content>' shape", () => {
    const ref = formatFileRef("src/app.js");
    const content = "console.log(1);";
    const expected = `${ref}\n${content}`;
    assert.equal(formatReferenceWithCode(ref, content, "diff"), expected);
    assert.equal(formatReferenceWithCode(ref, content, "plain"), expected);
  });

  test("an unrecognized format falls back to the same 'plain'-shaped output", () => {
    const ref = formatFileRef("src/app.js");
    const content = "console.log(1);";
    assert.equal(
      formatReferenceWithCode(ref, content, "bogus"),
      formatReferenceWithCode(ref, content, "plain")
    );
  });

  test("an '@lines:' ref with multi-line content renders correctly in 'markdown'", () => {
    const ref = formatLinesRef("src/app.js", 3, 5);
    const content = "line3\nline4\nline5";
    assert.equal(
      formatReferenceWithCode(ref, content, "markdown"),
      `### ${ref}\n\n\`\`\`javascript\n${content}\n\`\`\`\n`
    );
  });
});

// ---- copyTextToClipboard ----
//
// `navigator` is a built-in, getter-only global in this Node version (no
// setter), so it can't be reassigned with a plain `navigator = ...`; it must
// be replaced with `Object.defineProperty` and restored the same way
// afterward -- the same "capture original, stub, restore in `finally`"
// pattern `writeRefToHash`'s tests use for `window`, just via
// `defineProperty` instead of a plain assignment since `navigator`'s
// descriptor has no setter to assign through.

describe("copyTextToClipboard", () => {
  async function withNavigator(value, run) {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
    try {
      return await run();
    } finally {
      Object.defineProperty(globalThis, "navigator", original);
    }
  }

  test("returns {ok:false} with a string error when `navigator` itself is undefined", async () => {
    await withNavigator(undefined, async () => {
      const result = await copyTextToClipboard("hello");
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, "string");
    });
  });

  test("returns {ok:false} with a string error when navigator.clipboard is missing", async () => {
    await withNavigator({}, async () => {
      const result = await copyTextToClipboard("hello");
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, "string");
    });
  });

  test("returns {ok:false} with a string error when navigator.clipboard.writeText is not a function", async () => {
    await withNavigator({ clipboard: { writeText: "not a function" } }, async () => {
      const result = await copyTextToClipboard("hello");
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, "string");
    });
  });

  test("returns {ok:true} (and no error field) when writeText resolves successfully", async () => {
    await withNavigator({ clipboard: { writeText: async () => {} } }, async () => {
      const result = await copyTextToClipboard("hello");
      assert.deepEqual(result, { ok: true });
    });
  });

  test("returns {ok:false, error:<message>} when writeText rejects with a real Error", async () => {
    await withNavigator(
      {
        clipboard: {
          writeText: async () => {
            throw new Error("denied");
          },
        },
      },
      async () => {
        const result = await copyTextToClipboard("hello");
        assert.deepEqual(result, { ok: false, error: "denied" });
      }
    );
  });

  test("returns {ok:false, error:'null'} when writeText rejects with a non-Error `null` value", async () => {
    await withNavigator({ clipboard: { writeText: () => Promise.reject(null) } }, async () => {
      const result = await copyTextToClipboard("hello");
      assert.deepEqual(result, { ok: false, error: "null" });
    });
  });

  test("returns {ok:false, error:'undefined'} when writeText rejects with `undefined`", async () => {
    await withNavigator({ clipboard: { writeText: () => Promise.reject(undefined) } }, async () => {
      const result = await copyTextToClipboard("hello");
      assert.deepEqual(result, { ok: false, error: "undefined" });
    });
  });

  test("contract fix: error is always a string, even when the rejection value's `message` is a number rather than a real Error", () => {
    // Before the fix, `err && err.message ? err.message : String(err)` used
    // `err.message` as-is when truthy, so a reject value like
    // `{ message: 123 }` (not an Error, `message` a number) leaked a number
    // straight into `error` -- breaking the doc comment's "error is always a
    // plain string" contract. The fix routes `err.message` through `String()`
    // too, keyed on `!== undefined` rather than truthiness (so a falsy but
    // present message, like `""` or `0`, still takes this branch instead of
    // falling through to `String(err)`).
    return withNavigator(
      { clipboard: { writeText: () => Promise.reject({ message: 123 }) } },
      async () => {
        const result = await copyTextToClipboard("hello");
        assert.equal(typeof result.error, "string");
        assert.equal(result.error, "123");
      }
    );
  });

  test("each stub restores the original navigator descriptor afterward, so later tests see the real navigator again", () => {
    // Confirms the `finally` in `withNavigator` actually ran for every test
    // above: the global `navigator` here is Node's own getter-based
    // descriptor again, not one of this suite's plain-object stubs leaking
    // into later tests (this file runs as a single process, in order).
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    assert.equal(typeof descriptor.get, "function");
    assert.equal(descriptor.set, undefined);
  });
});

// ---- fetchFileContents ----

describe("fetchFileContents", () => {
  async function withFetch(mockFetch, run) {
    const originalFetch = global.fetch;
    global.fetch = mockFetch;
    try {
      return await run();
    } finally {
      global.fetch = originalFetch;
    }
  }

  test("resolves with {path, content} entries in the original path order, even when the underlying fetches settle out of order", async () => {
    const delays = { "a.txt": 30, "b.txt": 10, "c.txt": 20 };

    await withFetch(
      async (url) => {
        const path = new URL(url, "http://localhost").searchParams.get("path");
        await new Promise((resolve) => setTimeout(resolve, delays[path]));
        return { ok: true, text: async () => `content of ${path}` };
      },
      async () => {
        const result = await fetchFileContents(["a.txt", "b.txt", "c.txt"]);
        assert.deepEqual(result, [
          { path: "a.txt", content: "content of a.txt" },
          { path: "b.txt", content: "content of b.txt" },
          { path: "c.txt", content: "content of c.txt" },
        ]);
      }
    );
  });

  test("throws (failing the whole batch) if any single response is not ok, discarding the other successful results", async () => {
    await withFetch(
      async (url) => {
        const path = new URL(url, "http://localhost").searchParams.get("path");
        if (path === "bad.txt") return { ok: false, status: 404, text: async () => "" };
        return { ok: true, text: async () => `content of ${path}` };
      },
      async () => {
        await assert.rejects(() => fetchFileContents(["good.txt", "bad.txt"]));
      }
    );
  });

  test("resolves to an empty array for an empty paths list, without calling fetch at all", async () => {
    await withFetch(
      async () => {
        throw new Error("fetch should not be called for an empty paths list");
      },
      async () => {
        const result = await fetchFileContents([]);
        assert.deepEqual(result, []);
      }
    );
  });

  test("throws (failing the whole batch) if fetch itself throws", async () => {
    await withFetch(
      async () => {
        throw new Error("network down");
      },
      async () => {
        await assert.rejects(() => fetchFileContents(["a.txt"]));
      }
    );
  });
});

// ---- formatLabel ----

describe("formatLabel", () => {
  test("returns 'Plain' for 'plain'", () => {
    assert.equal(formatLabel("plain"), "Plain");
  });

  test("returns 'Markdown' for 'markdown'", () => {
    assert.equal(formatLabel("markdown"), "Markdown");
  });

  test("returns 'XML' for 'xml'", () => {
    assert.equal(formatLabel("xml"), "XML");
  });

  test("returns 'Diff' for 'diff'", () => {
    assert.equal(formatLabel("diff"), "Diff");
  });

  test("falls back to 'Plain' for an unrecognized format string", () => {
    assert.equal(formatLabel("bogus"), "Plain");
  });

  test("falls back to 'Plain' for undefined", () => {
    assert.equal(formatLabel(undefined), "Plain");
  });
});

// ---- Prompt composer (issue #7) ----

describe("describePromptTarget", () => {
  test("describes 'page' without needing any data", () => {
    assert.match(describePromptTarget("page"), /whole page/);
  });

  test("lists checked-file refs for 'checked' when some are checked", () => {
    const description = describePromptTarget("checked", {
      checkedRefs: ["@file:a.js", "@file:b.js"],
    });
    assert.match(description, /@file:a\.js, @file:b\.js/);
  });

  test("falls back to an explanatory phrase for 'checked' with nothing checked", () => {
    const description = describePromptTarget("checked", { checkedRefs: [] });
    assert.match(description, /none are currently checked/);
  });

  test("lists line refs for 'lines' when a selection exists, pluralizing for more than one", () => {
    const one = describePromptTarget("lines", { lineRefs: ["@lines:a.js#L1-L2"] });
    assert.match(one, /selected line range: @lines:a\.js#L1-L2/);

    const many = describePromptTarget("lines", {
      lineRefs: ["@lines:a.js#L1-L2", "@lines:b.js#L3"],
    });
    assert.match(many, /selected line ranges: @lines:a\.js#L1-L2, @lines:b\.js#L3/);
  });

  test("falls back to an explanatory phrase for 'lines' with nothing selected", () => {
    const description = describePromptTarget("lines", { lineRefs: [] });
    assert.match(description, /no lines are currently selected/);
  });

  test("describes 'diff' without needing any data", () => {
    assert.match(describePromptTarget("diff"), /current Git diff/);
  });

  test("defaults unrecognized targets to the 'page' description", () => {
    assert.equal(describePromptTarget("bogus"), describePromptTarget("page"));
  });

  test("tolerates being called with no data argument at all", () => {
    assert.doesNotThrow(() => describePromptTarget("checked"));
    assert.doesNotThrow(() => describePromptTarget("lines"));
  });
});

describe("describePromptOutput", () => {
  test("returns the fixed instruction for each non-file output", () => {
    for (const { value } of PROMPT_OUTPUTS) {
      if (value === "file") continue;
      assert.equal(typeof describePromptOutput(value), "string");
      assert.ok(describePromptOutput(value).length > 0);
    }
  });

  test("embeds a given filename for 'file'", () => {
    assert.equal(
      describePromptOutput("file", "test-spec.md"),
      "Generate the response as a downloadable file named `test-spec.md`."
    );
  });

  test("trims whitespace around a given filename", () => {
    assert.equal(
      describePromptOutput("file", "  test-spec.md  "),
      "Generate the response as a downloadable file named `test-spec.md`."
    );
  });

  test("falls back to 'output.md' for an empty/blank filename", () => {
    assert.match(describePromptOutput("file", ""), /output\.md/);
    assert.match(describePromptOutput("file", "   "), /output\.md/);
    assert.match(describePromptOutput("file", undefined), /output\.md/);
  });

  test("falls back to the 'concise' instruction for an unrecognized output", () => {
    assert.equal(describePromptOutput("bogus"), describePromptOutput("concise"));
  });

  test("escapes a backtick in a given filename so it can't prematurely close the code span", () => {
    // Without escaping, "out`put.md" wrapped in a single-backtick span would
    // read as "`out`" (closing early) followed by stray "put.md`" text.
    const text = describePromptOutput("file", "out`put.md");
    assert.equal(text, "Generate the response as a downloadable file named ``out`put.md``.");
  });
});

describe("buildPromptContextSection", () => {
  test("returns an empty string for 'page' regardless of entries (non-diff target)", () => {
    assert.equal(buildPromptContextSection("page", [{ ref: "@file:a.js", content: "x" }]), "");
    assert.equal(buildPromptContextSection("page", []), "");
  });

  test("embeds every entry, fenced and language-tagged via formatReferenceWithCode, under a '## Context' heading for 'excerpts'/'full'", () => {
    const entries = [
      { ref: "@file:a.js", content: "const a = 1;" },
      { ref: "@lines:b.js#L1-L2", content: "const b = 2;" },
    ];
    for (const mode of ["excerpts", "full"]) {
      const section = buildPromptContextSection(mode, entries);
      assert.match(section, /^## Context/);
      assert.match(section, /### @file:a\.js/);
      assert.match(section, /```javascript/);
      assert.match(section, /const a = 1;/);
      assert.match(section, /### @lines:b\.js#L1-L2/);
      assert.match(section, /const b = 2;/);
    }
  });

  test("a context entry's own Markdown/backticks can't corrupt the surrounding prompt structure", () => {
    // Regression guard for hand-rolled `### ${ref}\n\n${content}` formatting,
    // which embedded content raw with no fence at all -- a checked file
    // containing its own "```" block or a "## Context"-looking heading would
    // visually merge with the composer's own section structure. Routing
    // through formatReferenceWithCode wraps the entry in a fence escalated
    // past its own embedded 3-backtick run (to 4), so the entry's content
    // stays unambiguously inside its own code block.
    const entries = [{ ref: "@file:a.md", content: "## Context\n\n```\nnested\n```" }];
    const section = buildPromptContextSection("full", entries);
    assert.match(section, /````markdown\n/);
    assert.match(section, /nested/);
  });

  test("returns an explanatory placeholder for 'excerpts' with no entries", () => {
    assert.match(buildPromptContextSection("excerpts", []), /No line range is currently selected/);
    assert.match(buildPromptContextSection("excerpts", undefined), /No line range is currently selected/);
  });

  test("returns an explanatory placeholder for 'full' with no entries", () => {
    assert.match(buildPromptContextSection("full", []), /No files are currently checked/);
  });

  test("target 'diff' with context mode 'page' never embeds the diff, and explains why instead", () => {
    // Deliberately does not depend on contextEntries at all: "page" means
    // "don't embed anything" for target diff just like it does for every
    // other target, even if real diff content was already fetched.
    const section = buildPromptContextSection(
      "page",
      [{ content: "diff --git a/x b/x\n+added", isDiff: true }],
      "diff"
    );
    assert.match(section, /Page context only.*can't include it here/s);
    assert.doesNotMatch(section, /diff --git a\/x b\/x/);
    assert.doesNotMatch(section, /## Context/);
  });

  test("target 'diff' with context mode 'excerpts'/'full' embeds real diff content under a '## Context' heading, in a 'diff'-tagged fence", () => {
    for (const mode of ["excerpts", "full"]) {
      const section = buildPromptContextSection(
        mode,
        [{ content: "diff --git a/x b/x\n+added", isDiff: true }],
        "diff"
      );
      assert.match(section, /^## Context/);
      assert.match(section, /### Git diff/);
      assert.match(section, /```diff\n/);
      assert.match(section, /diff --git a\/x b\/x/);
      assert.match(section, /\+added/);
    }
  });

  test("target 'diff' with context mode 'excerpts'/'full' embeds an explanatory (non-diff) entry as plain text, not inside a diff fence", () => {
    for (const mode of ["excerpts", "full"]) {
      const section = buildPromptContextSection(
        mode,
        [{ content: "(No local changes: the working tree is clean.)", isDiff: false }],
        "diff"
      );
      assert.equal(section, "(No local changes: the working tree is clean.)");
      assert.doesNotMatch(section, /```/);
      assert.doesNotMatch(section, /## Context/);
    }
  });

  test("target 'diff' falls back to the (localized) clean-tree placeholder when no entry is given at all", () => {
    // The `!entry` branch is defensively unreachable in production, so it reuses
    // the clean-tree wording rather than carrying its own separate string.
    for (const mode of ["excerpts", "full"]) {
      assert.match(buildPromptContextSection(mode, [], "diff"), /No local changes: the working tree is clean/);
      assert.match(
        buildPromptContextSection(mode, undefined, "diff"),
        /No local changes: the working tree is clean/
      );
      assert.equal(
        buildPromptContextSection(mode, [], "diff", "ja"),
        "（ローカルの変更はありません。作業ツリーはクリーンです。）"
      );
    }
  });

  test("target 'diff' escalates the fence past any '```' already inside the diff content", () => {
    const section = buildPromptContextSection(
      "full",
      [{ content: "some content with ```\nembedded fence", isDiff: true }],
      "diff"
    );
    assert.match(section, /````diff\n/);
  });
});

describe("i18n diff/file-load status keys (issue #22, should-1/nit-1)", () => {
  const DIFF_STATUS_KEYS = ["diff.status.notRepo", "diff.status.clean", "diff.status.loadFailed"];

  test("every new diff-status key resolves in both en and ja (no blank, no en fallback for ja)", () => {
    for (const key of DIFF_STATUS_KEYS) {
      const en = tr("en", key, { detail: "X" });
      const ja = tr("ja", key, { detail: "X" });
      // A missing key would fall back to the key string itself.
      assert.notEqual(en, key, `en missing ${key}`);
      assert.notEqual(ja, key, `ja missing ${key}`);
      assert.notEqual(en, "");
      assert.notEqual(ja, "");
      // A ja key that merely fell back to en would compare equal.
      assert.notEqual(ja, en, `ja should differ from en for ${key}`);
    }
  });

  test("clean-tree / not-a-repo status strings are the expected prose in each locale", () => {
    assert.equal(tr("en", "diff.status.clean"), "(No local changes: the working tree is clean.)");
    assert.equal(tr("ja", "diff.status.clean"), "（ローカルの変更はありません。作業ツリーはクリーンです。）");
    assert.equal(
      tr("en", "diff.status.notRepo"),
      "(This directory is not a Git repository, so there is no diff to show.)"
    );
    assert.equal(
      tr("ja", "diff.status.notRepo"),
      "（このディレクトリは Git リポジトリではないため、表示できる差分はありません。）"
    );
  });

  test("loadFailed keeps the technical {detail} verbatim while localizing the surrounding prose", () => {
    assert.equal(
      tr("en", "diff.status.loadFailed", { detail: "HTTP 500" }),
      "(failed to load the Git diff: HTTP 500)"
    );
    assert.equal(
      tr("ja", "diff.status.loadFailed", { detail: "HTTP 500" }),
      "（Git 差分の取得に失敗しました: HTTP 500）"
    );
  });

  test("file.loadFailed (reused for embed failures) exists in both locales and carries {err} verbatim", () => {
    assert.equal(tr("en", "file.loadFailed", { err: '"a.js": HTTP 404' }), '(failed to load: "a.js": HTTP 404)');
    assert.equal(tr("ja", "file.loadFailed", { err: '"a.js": HTTP 404' }), "（読み込みに失敗しました: \"a.js\": HTTP 404）");
  });
});

describe("describeGitDiff (issue #22, should-1)", () => {
  test("returns real diff text verbatim as isDiff:true, untranslated, in any locale", () => {
    const diff = "diff --git a/x b/x\n+added";
    for (const locale of ["en", "ja"]) {
      assert.deepEqual(describeGitDiff({ isGitRepo: true, diff }, locale), { content: diff, isDiff: true });
    }
  });

  test("clean working tree resolves to localized prose (isDiff:false), no English literal in ja", () => {
    assert.deepEqual(describeGitDiff({ isGitRepo: true, diff: "" }, "en"), {
      content: "(No local changes: the working tree is clean.)",
      isDiff: false,
    });
    const ja = describeGitDiff({ isGitRepo: true, diff: "" }, "ja");
    assert.equal(ja.content, "（ローカルの変更はありません。作業ツリーはクリーンです。）");
    assert.equal(ja.isDiff, false);
    assert.doesNotMatch(ja.content, /No local changes|working tree|clean/);
  });

  test("non-Git directory resolves to localized prose (isDiff:false), no English literal in ja", () => {
    const ja = describeGitDiff({ isGitRepo: false, diff: "" }, "ja");
    assert.equal(ja.content, "（このディレクトリは Git リポジトリではないため、表示できる差分はありません。）");
    assert.equal(ja.isDiff, false);
    assert.doesNotMatch(ja.content, /not a Git repository|diff to show/);
  });

  test("defaults to English when no locale is passed", () => {
    assert.equal(
      describeGitDiff({ isGitRepo: false, diff: "" }).content,
      "(This directory is not a Git repository, so there is no diff to show.)"
    );
  });
});

describe("buildPromptText — diff-status prose is localized end-to-end (issue #22, should-1 regression)", () => {
  const baseDiffOptions = (contextEntries) => ({
    goal: "explain",
    target: "diff",
    output: "concise",
    contextMode: "full",
    filename: "",
    extraInstructions: "",
    checkedRefs: [],
    lineRefs: [],
    contextEntries,
  });

  test("ja prompt for a clean working tree carries the ja status sentence and no English diff-status literal", () => {
    // Content is what gatherDiffEntries -> describeGitDiff produces for a clean
    // tree in ja; buildPromptText must pass it through without English leaking.
    const jaClean = describeGitDiff({ isGitRepo: true, diff: "" }, "ja");
    const text = buildPromptText(baseDiffOptions([{ ref: "@diff", ...jaClean }]), "ja");
    assert.match(text, /（ローカルの変更はありません。作業ツリーはクリーンです。）/);
    assert.doesNotMatch(text, /No local changes/);
    assert.doesNotMatch(text, /working tree is clean/);
    assert.doesNotMatch(text, /is not a Git repository/);
    assert.doesNotMatch(text, /failed to load the Git diff/);
  });

  test("ja prompt for a non-Git directory carries the ja status sentence and no English diff-status literal", () => {
    const jaNotRepo = describeGitDiff({ isGitRepo: false, diff: "" }, "ja");
    const text = buildPromptText(baseDiffOptions([{ ref: "@diff", ...jaNotRepo }]), "ja");
    assert.match(text, /Git リポジトリではないため/);
    assert.doesNotMatch(text, /not a Git repository/);
    assert.doesNotMatch(text, /No local changes/);
  });
});

describe("buildPromptText", () => {
  test("produces a coherent, complete prompt for every goal x target x output x context-mode combination", () => {
    const checkedRefs = ["@file:src/app.js"];
    const lineRefs = ["@lines:src/app.js#L1-L3"];
    const contextEntries = [{ ref: "@file:src/app.js", content: "console.log(1);" }];

    for (const { value: goal } of PROMPT_GOALS) {
      for (const { value: target } of PROMPT_TARGETS) {
        for (const { value: output } of PROMPT_OUTPUTS) {
          for (const { value: contextMode } of PROMPT_CONTEXT_MODES) {
            const text = buildPromptText({
              goal,
              target,
              output,
              contextMode,
              filename: "result.md",
              extraInstructions: "",
              checkedRefs,
              lineRefs,
              contextEntries,
            });
            assert.equal(typeof text, "string");
            assert.ok(text.trim().length > 0, `${goal}/${target}/${output}/${contextMode} was empty`);
            assert.match(text, /Target:/);
          }
        }
      }
    }
  });

  test("degrades gracefully with nothing checked/selected and no context entries at all", () => {
    for (const { value: contextMode } of PROMPT_CONTEXT_MODES) {
      const text = buildPromptText({
        goal: "explain",
        target: "checked",
        output: "concise",
        contextMode,
        filename: "",
        extraInstructions: "",
        checkedRefs: [],
        lineRefs: [],
        contextEntries: [],
      });
      assert.ok(text.trim().length > 0);
    }
  });

  test("includes trimmed additional instructions when given, and omits the section when blank", () => {
    const withExtra = buildPromptText({
      goal: "explain",
      target: "page",
      output: "concise",
      contextMode: "page",
      extraInstructions: "  Focus on error handling.  ",
    });
    assert.match(withExtra, /Additional instructions:\nFocus on error handling\./);

    const withoutExtra = buildPromptText({
      goal: "explain",
      target: "page",
      output: "concise",
      contextMode: "page",
      extraInstructions: "   ",
    });
    assert.doesNotMatch(withoutExtra, /Additional instructions:/);
  });

  test("always mentions the stable-reference convention", () => {
    const text = buildPromptText({ goal: "explain", target: "page", output: "concise", contextMode: "page" });
    assert.match(text, /@file:\.\.\., @dir:\.\.\., @lines:\.\.\./);
  });

  test("embeds a filename instruction for 'file' output", () => {
    const text = buildPromptText({
      goal: "plan",
      target: "page",
      output: "file",
      contextMode: "page",
      filename: "plan.md",
    });
    assert.match(text, /downloadable file named `plan\.md`/);
  });

  test("embeds real diff content for target 'diff' in context modes 'excerpts'/'full'", () => {
    for (const contextMode of ["excerpts", "full"]) {
      const text = buildPromptText({
        goal: "review",
        target: "diff",
        output: "concise",
        contextMode,
        contextEntries: [{ content: "diff --git a/x b/x\n+added line", isDiff: true }],
      });
      assert.match(text, /## Context/);
      assert.match(text, /diff --git a\/x b\/x/);
      assert.match(text, /\+added line/);
    }
  });

  test("target 'diff' with context mode 'page' explains why the diff isn't embedded, instead of overriding the user's choice", () => {
    const text = buildPromptText({
      goal: "review",
      target: "diff",
      output: "concise",
      contextMode: "page",
      contextEntries: [{ content: "diff --git a/x b/x\n+added line", isDiff: true }],
    });
    assert.doesNotMatch(text, /## Context/);
    assert.doesNotMatch(text, /diff --git a\/x b\/x/);
    assert.match(text, /Page context only/);
  });
});

// ---- i18n: tr (message lookup + fallback chain) ----

describe("tr", () => {
  test("returns the Japanese string for a key present in the 'ja' catalog", () => {
    assert.equal(tr("ja", "stats.none"), "ファイルが選択されていません。");
    assert.equal(tr("ja", "composer.generate"), "プロンプトを生成");
  });

  test("returns the English string for the 'en' locale", () => {
    assert.equal(tr("en", "stats.none"), "No files selected.");
    assert.equal(tr("en", "composer.generate"), "Generate prompt");
  });

  test("returns the preset group title for both locales (added with the preset chips redesign)", () => {
    assert.equal(tr("en", "preset.groupTitle"), "Quick select");
    assert.equal(tr("ja", "preset.groupTitle"), "クイック選択");
  });

  test("distinguishes 'Clear history' (recent files) from 'Clear selection' (presets) in both locales (issue #26)", () => {
    assert.equal(tr("en", "recent.clear"), "Clear history");
    assert.equal(tr("ja", "recent.clear"), "履歴をクリア");
    assert.equal(tr("en", "preset.clearSelection"), "Clear selection");
    assert.equal(tr("ja", "preset.clearSelection"), "選択をクリア");
    assert.notEqual(tr("en", "recent.clear"), tr("en", "preset.clearSelection"));
    assert.notEqual(tr("ja", "recent.clear"), tr("ja", "preset.clearSelection"));
  });

  test("returns the revised security notice text for both locales (issue #28: names the actual risk instead of implying the app itself is dangerous)", () => {
    assert.match(tr("en", "security.notice"), /third-party AI/);
    assert.match(tr("en", "security.notice"), /untrusted input/);
    assert.match(tr("ja", "security.notice"), /外部のAI/);
    assert.match(tr("ja", "security.notice"), /信頼できない入力/);
  });

  test("returns the security notice dismiss/collapsed-strip control strings for both locales (issue #28, revised by issue #36)", () => {
    assert.equal(tr("en", "security.dismiss"), "Dismiss this notice");
    assert.equal(tr("ja", "security.dismiss"), "この通知を閉じる");
    assert.equal(tr("en", "security.collapsedLabel"), "Safety notice");
    assert.equal(tr("ja", "security.collapsedLabel"), "安全性の通知");
  });

  test("falls back to English for an unsupported locale (its table is missing entirely)", () => {
    // MESSAGES has no "fr" table, so the lookup drops to the English one.
    assert.equal(tr("fr", "stats.none"), "No files selected.");
    assert.equal(tr("de", "composer.generate"), "Generate prompt");
  });

  test("returns the key itself -- never an empty string -- for a key missing from every catalog", () => {
    // The `?? MESSAGES.en[key] ?? key` tail guarantees a missing translation
    // renders as the (visible) key, so a forgotten string is obvious rather
    // than silently blank. The en/ja catalogs are currently perfectly
    // mirrored, so an unknown key is the only way to reach this branch.
    const unknown = "this.key.does.not.exist";
    assert.equal(tr("ja", unknown), unknown);
    assert.equal(tr("en", unknown), unknown);
    assert.notEqual(tr("ja", unknown), "");
    assert.notEqual(tr("en", unknown), "");
  });

  test("substitutes {name}-style params in the looked-up string", () => {
    assert.equal(tr("ja", "stats.manyFiles", { count: 3 }), "3 ファイル選択中");
    assert.equal(
      tr("en", "output.file.instruction", { name: "spec.md" }),
      "Generate the response as a downloadable file named spec.md."
    );
  });

  test("inserts a param value containing regex-replacement tokens ($&, $1) verbatim through the public tr path", () => {
    // If substitution used a string replacement, "$&" would expand to the
    // matched "{count}" and "$1" to a capture group. It must stay literal.
    assert.equal(tr("en", "stats.manyFiles", { count: "$&" }), "$& files selected");
    assert.equal(tr("ja", "stats.manyFiles", { count: "$1" }), "$1 ファイル選択中");
  });
});

// ---- i18n: substituteParams (placeholder replacement semantics) ----

describe("substituteParams", () => {
  test("replaces a {token} with the matching param value", () => {
    assert.equal(substituteParams("Hello {name}!", { name: "world" }), "Hello world!");
  });

  test("inserts a value containing '$&' or '$1' verbatim (no regex-replacement expansion)", () => {
    // With String.prototype.replace(pattern, string), "$&" would re-insert the
    // matched "{name}" and "$1" a capture group; the function replacement used
    // here makes both literal.
    assert.equal(substituteParams("x {name} y", { name: "$&" }), "x $& y");
    assert.equal(substituteParams("x {name} y", { name: "$1" }), "x $1 y");
    assert.equal(substituteParams("x {name} y", { name: "$$" }), "x $$ y");
  });

  test("does not re-substitute a value that itself contains a {placeholder} token", () => {
    // The template is scanned exactly once; a "{b}" produced by substituting
    // {a} is NOT expanded again even when a `b` param is also present.
    assert.equal(substituteParams("{a}", { a: "{b}", b: "B" }), "{b}");
    assert.equal(substituteParams("start {a} end", { a: "{name}" }), "start {name} end");
  });

  test("leaves an unmatched {placeholder} in place when its param is missing", () => {
    assert.equal(substituteParams("Hi {missing}", {}), "Hi {missing}");
    assert.equal(substituteParams("Hi {missing}", { other: "x" }), "Hi {missing}");
    assert.equal(
      substituteParams("{present} {missing}", { present: "P" }),
      "P {missing}"
    );
  });

  test("returns the template unchanged when params is null/undefined", () => {
    assert.equal(substituteParams("{a} literal", undefined), "{a} literal");
    assert.equal(substituteParams("{a} literal", null), "{a} literal");
  });
});

// ---- i18n: buildPromptText locale support + English backward compatibility ----

describe("buildPromptText - i18n", () => {
  test("renders the Japanese target line, goal, output and reference note for locale 'ja'", () => {
    const text = buildPromptText(
      {
        goal: "explain",
        target: "page",
        output: "concise",
        contextMode: "page",
      },
      "ja"
    );
    // Japanese "Target:" line.
    assert.match(text, /対象: /);
    assert.match(text, /。/);
    // Japanese goal instruction (explain).
    assert.match(text, /このコードが何をするか、どのように動作するかを説明してください。/);
    // Japanese output instruction (concise).
    assert.match(text, /簡潔な回答で答えてください。/);
    // Japanese reference-convention note.
    assert.match(text, /安定参照/);
    // And none of the English equivalents leaked in.
    assert.doesNotMatch(text, /Target:/);
    assert.doesNotMatch(text, /Respond with a concise answer/);
  });

  test("embeds Japanese target phrases for 'checked' and 'diff' targets", () => {
    const checked = buildPromptText(
      {
        goal: "review",
        target: "checked",
        output: "concise",
        contextMode: "page",
        checkedRefs: ["@file:src/app.js"],
      },
      "ja"
    );
    assert.match(checked, /対象: チェックしたファイル: @file:src\/app\.js。/);

    const diff = buildPromptText(
      { goal: "review", target: "diff", output: "concise", contextMode: "page" },
      "ja"
    );
    assert.match(diff, /このプロジェクトの現在のGit差分/);
  });

  test("omitting the locale is byte-identical to passing 'en' (backward compatibility)", () => {
    // A representative spread of option shapes, including the branches that
    // pull in extra instructions, a filename, and embedded diff/context.
    const optionSets = [
      { goal: "explain", target: "page", output: "concise", contextMode: "page" },
      {
        goal: "plan",
        target: "checked",
        output: "file",
        contextMode: "full",
        filename: "plan.md",
        extraInstructions: "  Focus on error handling.  ",
        checkedRefs: ["@file:src/app.js", "@file:src/lib.js"],
        contextEntries: [{ ref: "@file:src/app.js", content: "console.log(1);" }],
      },
      {
        goal: "review",
        target: "diff",
        output: "report",
        contextMode: "excerpts",
        contextEntries: [{ content: "diff --git a/x b/x\n+added", isDiff: true }],
      },
      {
        goal: "locate",
        target: "lines",
        output: "issue",
        contextMode: "excerpts",
        lineRefs: ["@lines:a.js#L1-L2", "@lines:b.js#L3"],
        contextEntries: [{ ref: "@lines:a.js#L1-L2", content: "const a = 1;" }],
      },
    ];
    for (const options of optionSets) {
      assert.equal(buildPromptText(options), buildPromptText(options, "en"));
    }
  });

  test("the Japanese rendering actually differs from the English one (sanity: locale is wired through)", () => {
    const options = {
      goal: "explain",
      target: "page",
      output: "concise",
      contextMode: "page",
      extraInstructions: "note",
    };
    assert.notEqual(buildPromptText(options, "ja"), buildPromptText(options, "en"));
  });
});

// ---- i18n: describePromptOutput Japanese fallback ----

describe("describePromptOutput - i18n", () => {
  test("falls back to the Japanese 'concise' instruction for an unrecognized output", () => {
    // Mirrors the English fallback test, but for locale 'ja'.
    assert.equal(
      describePromptOutput("bogus", undefined, "ja"),
      describePromptOutput("concise", undefined, "ja")
    );
    assert.equal(describePromptOutput("bogus", undefined, "ja"), "簡潔な回答で答えてください。");
  });

  test("embeds a given filename in the Japanese 'file' instruction", () => {
    assert.equal(
      describePromptOutput("file", "plan.md", "ja"),
      "回答を `plan.md` という名前のダウンロード可能なファイルとして生成してください。"
    );
  });
});

// ---- i18n: formatSelectionStats Japanese ----

describe("formatSelectionStats - i18n", () => {
  test("reports the Japanese empty-selection message", () => {
    const stats = computeSelectionStats([], new Map());
    assert.equal(formatSelectionStats(stats, "ja"), "ファイルが選択されていません。");
  });

  test("uses Japanese singular phrasing for exactly one file", () => {
    const stats = computeSelectionStats(["a.js"], new Map([["a.js", "abcd"]]));
    assert.match(formatSelectionStats(stats, "ja"), /^1 ファイル選択中/);
  });

  test("uses Japanese plural phrasing for more than one file", () => {
    const stats = computeSelectionStats(
      ["a.js", "b.js"],
      new Map([
        ["a.js", "ab"],
        ["b.js", "cd"],
      ])
    );
    assert.match(formatSelectionStats(stats, "ja"), /^2 ファイル選択中/);
  });

  test("notes the Japanese pending count when some checked files haven't loaded yet", () => {
    const stats = computeSelectionStats(["a.js", "b.js"], new Map([["a.js", "abcd"]]));
    assert.match(formatSelectionStats(stats, "ja"), /（1 件読み込み中）/);
  });

  test("appends the Japanese large-selection warning only when isLarge is true", () => {
    const small = computeSelectionStats(["a.js"], new Map([["a.js", "abcd"]]));
    assert.doesNotMatch(formatSelectionStats(small, "ja"), /選択が大きすぎます/);

    const large = computeSelectionStats(["a.js"], new Map([["a.js", "x".repeat(200_001)]]));
    assert.match(formatSelectionStats(large, "ja"), /· ⚠ 選択が大きすぎます$/);
  });
});

// ---- i18n: detectInitialLocale (stored choice vs navigator, resilient to failures) ----

// detectInitialLocale reads the ambient `localStorage`/`navigator` globals.
// Node has a built-in (getter-only but configurable) `navigator` and no
// `localStorage`, so each case runs with those globals temporarily swapped and
// then fully restored, keeping the cases isolated from each other.
function withLocaleGlobals({ localStorage, navigator }, fn) {
  const hadLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setOrDelete = (name, value) => {
    if (value === undefined) {
      delete globalThis[name];
    } else {
      Object.defineProperty(globalThis, name, {
        value,
        configurable: true,
        writable: true,
      });
    }
  };
  const restore = (name, desc) => {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else delete globalThis[name];
  };
  setOrDelete("localStorage", localStorage);
  setOrDelete("navigator", navigator);
  try {
    return fn();
  } finally {
    restore("localStorage", hadLS);
    restore("navigator", hadNav);
  }
}

/** A localStorage stub returning `value` for the locale key (and null otherwise). */
function storageReturning(value) {
  return { getItem: (key) => (key === "pbsa-locale" ? value : null) };
}

const throwingStorage = {
  getItem() {
    throw new Error("SecurityError: storage is disabled");
  },
};

describe("detectInitialLocale", () => {
  test("a valid stored choice wins over navigator.language", () => {
    const result = withLocaleGlobals(
      { localStorage: storageReturning("en"), navigator: { language: "ja-JP" } },
      detectInitialLocale
    );
    assert.equal(result, "en");
  });

  test("navigator.language starting with 'ja' auto-selects Japanese when nothing is stored", () => {
    const result = withLocaleGlobals(
      { localStorage: storageReturning(null), navigator: { language: "ja-JP" } },
      detectInitialLocale
    );
    assert.equal(result, "ja");
  });

  test("a stored 'ja' choice is honored even with no navigator at all", () => {
    const result = withLocaleGlobals(
      { localStorage: storageReturning("ja"), navigator: undefined },
      detectInitialLocale
    );
    assert.equal(result, "ja");
  });

  test("falls back to English when nothing is stored and navigator.language is non-Japanese", () => {
    const result = withLocaleGlobals(
      { localStorage: storageReturning(null), navigator: { language: "en-US" } },
      detectInitialLocale
    );
    assert.equal(result, "en");
  });

  test("ignores a stored value that isn't a supported locale and falls through to navigator", () => {
    const result = withLocaleGlobals(
      { localStorage: storageReturning("fr"), navigator: { language: "ja-JP" } },
      detectInitialLocale
    );
    assert.equal(result, "ja");
  });

  test("does not throw and returns 'en' when localStorage access throws (private browsing)", () => {
    assert.doesNotThrow(() =>
      withLocaleGlobals(
        { localStorage: throwingStorage, navigator: { language: "en-US" } },
        detectInitialLocale
      )
    );
    const result = withLocaleGlobals(
      { localStorage: throwingStorage, navigator: { language: "en-US" } },
      detectInitialLocale
    );
    assert.equal(result, "en");
  });

  test("recovers from a throwing localStorage and still honors navigator.language", () => {
    // The storage exception is swallowed, so the navigator branch still runs.
    const result = withLocaleGlobals(
      { localStorage: throwingStorage, navigator: { language: "ja" } },
      detectInitialLocale
    );
    assert.equal(result, "ja");
  });

  test("falls back to English when neither localStorage nor navigator is available", () => {
    const result = withLocaleGlobals(
      { localStorage: undefined, navigator: undefined },
      detectInitialLocale
    );
    assert.equal(result, "en");
  });
});

// ---- Security notice dismiss/reopen (issue #28/#36): loadSecurityNoticeDismissed / saveSecurityNoticeDismissed ----
//
// Same ambient-`localStorage`-swap approach as `withLocaleGlobals` above,
// scoped to just `localStorage` since these two functions (unlike
// `detectInitialLocale`) never touch `navigator`.

function withStorage(localStorage, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (localStorage === undefined) {
    delete globalThis.localStorage;
  } else {
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorage,
      configurable: true,
      writable: true,
    });
  }
  try {
    return fn();
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had);
    else delete globalThis.localStorage;
  }
}

/** A localStorage stub returning `value` for the security-notice-dismissed
 * key (and null otherwise), mirroring `storageReturning` above. */
function securityStorageReturning(value) {
  return { getItem: (key) => (key === "pbsa-security-notice-dismissed" ? value : null) };
}

describe("loadSecurityNoticeDismissed", () => {
  test("returns true when the stored value is exactly '1'", () => {
    const result = withStorage(securityStorageReturning("1"), loadSecurityNoticeDismissed);
    assert.equal(result, true);
  });

  test("returns false when nothing is stored (getItem returns null)", () => {
    const result = withStorage(securityStorageReturning(null), loadSecurityNoticeDismissed);
    assert.equal(result, false);
  });

  test("returns false for an empty string", () => {
    const result = withStorage(securityStorageReturning(""), loadSecurityNoticeDismissed);
    assert.equal(result, false);
  });

  test("returns false for any stored value other than the literal '1' (equivalence class: 'true', '0')", () => {
    assert.equal(withStorage(securityStorageReturning("true"), loadSecurityNoticeDismissed), false);
    assert.equal(withStorage(securityStorageReturning("0"), loadSecurityNoticeDismissed), false);
  });

  test("falls back to false, without propagating the exception, when localStorage access throws", () => {
    assert.doesNotThrow(() => withStorage(throwingStorage, loadSecurityNoticeDismissed));
    assert.equal(withStorage(throwingStorage, loadSecurityNoticeDismissed), false);
  });
});

describe("saveSecurityNoticeDismissed", () => {
  test("dismissed=true calls localStorage.setItem with the storage key and '1'", () => {
    const calls = { setItem: [], removeItem: [] };
    const storage = {
      setItem: (...args) => calls.setItem.push(args),
      removeItem: (...args) => calls.removeItem.push(args),
    };
    withStorage(storage, () => saveSecurityNoticeDismissed(true));
    assert.deepEqual(calls.setItem, [["pbsa-security-notice-dismissed", "1"]]);
    assert.deepEqual(calls.removeItem, []);
  });

  test("dismissed=false calls localStorage.removeItem with the storage key", () => {
    const calls = { setItem: [], removeItem: [] };
    const storage = {
      setItem: (...args) => calls.setItem.push(args),
      removeItem: (...args) => calls.removeItem.push(args),
    };
    withStorage(storage, () => saveSecurityNoticeDismissed(false));
    assert.deepEqual(calls.removeItem, [["pbsa-security-notice-dismissed"]]);
    assert.deepEqual(calls.setItem, []);
  });

  test("swallows an exception from a disabled/throwing localStorage instead of propagating it", () => {
    const throwingWriteStorage = {
      setItem() {
        throw new Error("SecurityError: storage is disabled");
      },
      removeItem() {
        throw new Error("SecurityError: storage is disabled");
      },
    };
    assert.doesNotThrow(() => withStorage(throwingWriteStorage, () => saveSecurityNoticeDismissed(true)));
    assert.doesNotThrow(() => withStorage(throwingWriteStorage, () => saveSecurityNoticeDismissed(false)));
  });
});

// ---- computeSecurityNoticeDomState (issue #35/#36, should-1) ----
//
// Pure computation extracted from `setSecurityNoticeVisible` so the
// notice/collapsed-strip DOM-state logic is testable without a DOM.

describe("computeSecurityNoticeDomState", () => {
  test("visible=true: shows the full notice, hides the collapsed strip, and marks it expanded", () => {
    assert.deepEqual(computeSecurityNoticeDomState(true), {
      noticeHidden: false,
      collapsedHidden: true,
      collapsedAriaExpanded: "true",
    });
  });

  test("visible=false: hides the full notice, shows the collapsed strip, and marks it collapsed", () => {
    assert.deepEqual(computeSecurityNoticeDomState(false), {
      noticeHidden: true,
      collapsedHidden: false,
      collapsedAriaExpanded: "false",
    });
  });
});

// ---- tr: security notice message-catalog keys (issue #35/#36 regression) ----

describe("tr - security notice labels", () => {
  test("English 'security.collapsedLabel' reads 'Safety notice'", () => {
    assert.equal(tr("en", "security.collapsedLabel"), "Safety notice");
  });

  test("Japanese 'security.collapsedLabel' reads '安全性の通知'", () => {
    assert.equal(tr("ja", "security.collapsedLabel"), "安全性の通知");
  });

  test("the removed issue #28-era 'security.reopenLabel' key no longer exists in either locale (tr falls back to the raw key, proving no translation was found)", () => {
    assert.equal(tr("en", "security.reopenLabel"), "security.reopenLabel");
    assert.equal(tr("ja", "security.reopenLabel"), "security.reopenLabel");
  });

  test("the removed issue #28-era 'security.reopenAria' key no longer exists in either locale (tr falls back to the raw key, proving no translation was found)", () => {
    assert.equal(tr("en", "security.reopenAria"), "security.reopenAria");
    assert.equal(tr("ja", "security.reopenAria"), "security.reopenAria");
  });
});
