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
