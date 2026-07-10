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
