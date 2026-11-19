import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLDS, measureCommentDensity, renderAgentMessage, renderStatusLine } from "./commentDensity.mts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleHook } from "./claudeHook.mts";

function diffFor(path: string, lines: string[]): string {
  return (
    [
      `diff --git a/${path} b/${path}`,
      "index 0000000..1111111 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,0 +1,9 @@",
      ...lines,
    ].join("\n") + "\n"
  );
}

function counts(diff: string): [number, number] {
  const report = measureCommentDensity(diff);
  return [report.addedCodeLines, report.addedCommentLines];
}

describe("measureCommentDensity counting, ported from PostHog", () => {
  test("python: shebang, triple-quoted strings and removed lines", () => {
    const diff = diffFor("posthog/api/thing.py", [
      "+#!/usr/bin/env python3",
      "+# explain why",
      "+x = 1  # trailing comments are code lines",
      "+",
      "-# removed comment",
      "-removed = 2",
      "+PROMPT = '''",
      "+# Markdown heading inside a string",
      "+## Use this when:",
      "+'''",
      "+# a real comment after the string",
    ]);
    assert.deepEqual(counts(diff), [8, 2]);
  });

  test("typescript: block, line, JSX and template-literal comments", () => {
    const diff = diffFor("frontend/src/lib/thing.ts", [
      "+/**",
      "+ * Block comment with one ` marker",
      "+ */",
      "+const a = 1 // trailing",
      "+// full line",
      "+{/* jsx style */}",
      "+const b = 2",
      "+/* note */ doWork()",
      "+*ptr = 1",
      "+const snippet = `",
      "+// rendered SDK line",
      "+const escaped = \\`code\\`",
      "+/* rendered block */",
      "+`",
      '+const label = "Use one ` marker"',
      "+// real comment with one ` marker",
      "+// another real comment",
    ]);
    assert.deepEqual(counts(diff), [17, 7]);
  });

  test("block state follows context lines, not removed lines", () => {
    const diff = diffFor("frontend/src/lib/other.ts", [
      " /**",
      "+ * doc line added inside a block that opened in context",
      "+ */",
      "+const c = 3",
      "-/*",
      "+const d = 4",
    ]);
    assert.deepEqual(counts(diff), [4, 2]);
  });

  test("only generated paths and non-code files are ignored", () => {
    const diff =
      diffFor("frontend/src/generated/api.ts", ["+// generated", "+// generated"]) +
      diffFor("frontend/src/lib/agentScopes.generated.ts", ["+// AUTO-GENERATED", "+// Do not edit"]) +
      diffFor("products/x/backend/generated_configs/ably.py", ["+# generated", "+# do not edit"]) +
      diffFor("posthog/hogql/test/_generated_grammar_strategies.py", ["+# generated", "+# do not edit"]) +
      diffFor(".github/workflows/ci.yml", ["+# yaml prose", "+run: echo"]) +
      diffFor("posthog/test/__snapshots__/x.ambr", ["+# name: test"]) +
      diffFor("docs/readme.md", ["+<!-- not code -->"]) +
      diffFor("posthog/hogql/q.sql", ["+-- sql comment", "+SELECT 1"]) +
      diffFor("products/notebooks/frontend/NotebookNodeGeneratedWidget/index.ts", [
        "+// hand-written component",
        "+export const widget = 1",
      ]) +
      diffFor("services/mcp/tests/unit/schema-generated.test.ts", ["+// hand-written test", "+const schema = 1"]);
    assert.deepEqual(counts(diff), [6, 3]);
  });

  test("block comment state does not carry across hunks", () => {
    const diff = [
      "diff --git a/frontend/src/lib/thing.ts b/frontend/src/lib/thing.ts",
      "--- a/frontend/src/lib/thing.ts",
      "+++ b/frontend/src/lib/thing.ts",
      "@@ -1 +1 @@",
      "-/** old summary",
      "+/** new summary",
      "@@ -40,0 +40,2 @@",
      "+export const a = 1",
      "+export const b = 2",
      "",
    ].join("\n");
    assert.deepEqual(counts(diff), [3, 1]);
  });
});

describe("hunk-start state from the post-image", () => {
  function hunk(path: string, header: string, lines: string[]): string {
    return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, header, ...lines, ""].join("\n");
  }

  function countsWith(diff: string, postImages: Record<string, string>): [number, number] {
    const report = measureCommentDensity(diff, {}, (path) => postImages[path]);
    return [report.addedCodeLines, report.addedCommentLines];
  }

  const templateDiff = hunk("src/styles.ts", "@@ -4,4 +4,9 @@ const STYLES = `", [
    "   }",
    "   li { margin: 0; }",
    " `;",
    " ",
    "+// Inside markers break the hanging indent of wrapped lines.",
    "+const INSIDE = `",
    "+  ul { list-style: inside; }",
    "+`;",
    "+",
  ]);
  const templatePostImage = [
    "const STYLES = `",
    "  ul {",
    "    margin: 0;",
    "  }",
    "  li { margin: 0; }",
    "`;",
    "",
    "// Inside markers break the hanging indent of wrapped lines.",
    "const INSIDE = `",
    "  ul { list-style: inside; }",
    "`;",
    "",
  ].join("\n");

  test("a hunk that starts inside a template literal reads the literal's closing backtick as a close", () => {
    assert.deepEqual(countsWith(templateDiff, { "src/styles.ts": templatePostImage }), [4, 1]);
  });

  test("without a post-image a hunk starts at top level", () => {
    assert.deepEqual(counts(templateDiff), [4, 0]);
  });

  test("a lookup returning undefined starts the hunk at top level", () => {
    assert.deepEqual(countsWith(templateDiff, {}), [4, 0]);
  });

  test("a hunk that starts inside a block comment counts its added lines as comments", () => {
    const diff = hunk("src/doc.ts", "@@ -3,4 +3,6 @@", [
      "  * One.",
      "  * Two.",
      "  * Three.",
      "+ * Added one.",
      "+ * Added two.",
      "  */",
      " export function f() {}",
    ]);
    const postImage = [
      "export const a = 1;",
      "/**",
      " * One.",
      " * Two.",
      " * Three.",
      " * Added one.",
      " * Added two.",
      " */",
      "export function f() {}",
    ].join("\n");
    assert.deepEqual(countsWith(diff, { "src/doc.ts": postImage }), [2, 2]);
  });

  test("a hunk that starts inside a template literal counts added // lines as code", () => {
    const diff = hunk("src/script.ts", "@@ -2,4 +2,6 @@", [
      "   init();",
      "   run();",
      "   done();",
      "+// first line of embedded script",
      "+// second",
      " `;",
    ]);
    const postImage = [
      "const SCRIPT = `",
      "  init();",
      "  run();",
      "  done();",
      "// first line of embedded script",
      "// second",
      "`;",
    ].join("\n");
    assert.deepEqual(countsWith(diff, { "src/script.ts": postImage }), [2, 0]);
  });

  test("a Python hunk that starts inside a triple-quoted string counts added # lines as code", () => {
    const diff = hunk("app/prompt.py", "@@ -2,4 +2,6 @@", [
      " Intro.",
      " More.",
      " Even more.",
      "+# Heading",
      "+## Use this when:",
      " '''",
    ]);
    const postImage = ["PROMPT = '''", "Intro.", "More.", "Even more.", "# Heading", "## Use this when:", "'''"].join(
      "\n",
    );
    assert.deepEqual(countsWith(diff, { "app/prompt.py": postImage }), [2, 0]);
  });
});

describe("status ladder", () => {
  function statusFor(code: number, comments: number, thresholds = {}): string {
    const lines = [...Array(code).fill("+x = 1"), ...Array(comments).fill("+# c")];
    return measureCommentDensity(diffFor("posthog/a.py", lines), thresholds).status;
  }

  test("defaults", () => {
    assert.deepEqual(DEFAULT_THRESHOLDS, { warnRatio: 0.03, alertRatio: 0.06, minAddedCodeLines: 20 });
  });
  test("below the floor is always ok", () => assert.equal(statusFor(5, 14), "ok"));
  test("exactly at the floor is measured", () => assert.equal(statusFor(10, 10), "alert"));
  test("at the warn threshold is ok", () => assert.equal(statusFor(97, 3), "ok"));
  test("above the warn threshold warns", () => assert.equal(statusFor(96, 4), "warn"));
  test("at the alert threshold warns", () => assert.equal(statusFor(94, 6), "warn"));
  test("above the alert threshold alerts", () => assert.equal(statusFor(93, 7), "alert"));
  test("thresholds override the defaults", () => {
    assert.equal(statusFor(10, 30, { minAddedCodeLines: 50 }), "ok");
  });
  test("an empty diff is ok with a zero ratio", () => {
    const report = measureCommentDensity("");
    assert.equal(report.status, "ok");
    assert.equal(report.ratio, 0);
  });
});

describe("per-file report", () => {
  test("lists comment-heavy files first, then by path, and drops files with no added code", () => {
    const diff =
      diffFor("posthog/a.py", ["+# one", "+x = 1"]) +
      diffFor("posthog/c.py", ["+# one", "+z = 1"]) +
      diffFor("posthog/b.py", ["+# one", "+# two", "+y = 2"]) +
      diffFor("posthog/d.py", ["-removed = 1"]);
    assert.deepEqual(measureCommentDensity(diff).files, [
      { path: "posthog/b.py", addedCodeLines: 3, addedCommentLines: 2 },
      { path: "posthog/a.py", addedCodeLines: 2, addedCommentLines: 1 },
      { path: "posthog/c.py", addedCodeLines: 2, addedCommentLines: 1 },
    ]);
  });
});

describe("additions to the PostHog rules", () => {
  test(".mts and .cts files are measured", () => {
    const diff = diffFor("src/a.mts", ["+// c", "+const a = 1"]) + diffFor("src/b.cts", ["+// c", "+const b = 1"]);
    assert.deepEqual(counts(diff), [4, 2]);
  });

  test("CRLF diffs count the same as LF diffs", () => {
    const diff = diffFor("src/a.ts", ["+// c", "+const a = 1"]).replaceAll("\n", "\r\n");
    assert.deepEqual(counts(diff), [2, 1]);
  });

  test("a leading BOM keeps the line out of the comment count, as in Python", () => {
    assert.deepEqual(counts(diffFor("src/a.ts", ["+\uFEFF// header", "+const a = 1"])), [2, 0]);
  });

  test("the percentage rounds half to even, as Python's round() does", () => {
    const lines = [...Array(39).fill("+const a = 1"), "+// c"];
    assert.equal(
      renderStatusLine(measureCommentDensity(diffFor("src/a.ts", lines))),
      "status=ok 2% of added code lines are comments (1 of 40)",
    );
  });
});

describe("known blind spots, kept as in PostHog", () => {
  test("a quote inside a regex literal can open a phantom block comment", () => {
    const diff = diffFor("src/a.ts", ['+const quote = /"/, open = "/*"', "+const next = 1"]);
    assert.deepEqual(counts(diff), [2, 1]);
  });

  test("// inside a regex literal hides a template literal that opens after it", () => {
    const diff = diffFor("src/a.ts", ["+const re = /\\/\\//, s = `", "+// inside the template", "+`"]);
    assert.deepEqual(counts(diff), [3, 1]);
  });

  test("a reworded comment counts as a newly added comment", () => {
    const diff = diffFor("src/a.ts", ["-// old wording", "+// new wording", "+const a = 1"]);
    assert.deepEqual(counts(diff), [2, 1]);
  });
});

function codeAdditions(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `+const value${i} = ${i}`);
}

describe("renderAgentMessage", () => {
  const heavy = measureCommentDensity(
    diffFor("src/a.ts", ["+// one", ...codeAdditions(20)]) +
      diffFor("src/b.ts", ["+// one", "+// two", "+const y = 2"]),
  );

  test("commit mode tells the agent to amend or follow up, and how many lines to remove", () => {
    const message = renderAgentMessage(heavy, "commit");
    assert.ok(message.startsWith("Warning: 12% of added code lines are comments (3 of 24) in this commit.\n"));
    assert.ok(message.includes("git commit --amend --no-edit, or make a follow-up commit."));
    assert.ok(message.includes("Remove at least 3 of the 3 added comment lines to get under 3%."));
    assert.ok(message.includes("about 2%"));
    assert.ok(message.includes("  src/b.ts (2 of 3)\n  src/a.ts (1 of 21)\n"));
    assert.ok(message.includes("this warning is addressed to you"));
    assert.ok(message.includes("Do not reword the comments"));
    assert.ok(message.includes("~/.claude/skills/writing-code-comments/SKILL.md"));
  });

  test("branch mode tells the agent to fold removals into the commits that added them", () => {
    const message = renderAgentMessage(heavy, "branch");
    assert.ok(message.startsWith("Warning: 12% of added code lines are comments (3 of 24) in this branch.\n"));
    assert.ok(message.includes("Fold the removals into the commits that added them"));
    assert.ok(!message.includes("--amend"));
  });

  test("lists at most 8 files and only ones with added comments", () => {
    const diff =
      Array.from({ length: 10 }, (_, i) =>
        diffFor(`src/f${i}.ts`, [...Array(i + 1).fill("+// c"), "+const a = 1"]),
      ).join("") + diffFor("src/z.ts", codeAdditions(5));
    const listed = renderAgentMessage(measureCommentDensity(diff), "commit")
      .split("\n")
      .filter((line) => line.startsWith("  src/"));
    assert.equal(listed.length, 8);
    assert.equal(listed[0], "  src/f9.ts (10 of 11)");
    assert.equal(listed[7], "  src/f2.ts (3 of 4)");
  });

  test("the target uses the warn ratio it is given", () => {
    const message = renderAgentMessage(heavy, "commit", 0.05);
    assert.ok(message.includes("Remove at least 2 of the 3 added comment lines to get under 5%."));
  });
});

const CLI_PATH = fileURLToPath(new URL("./cli.mts", import.meta.url));

const GIT_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "comment-density-"));
  tempDirs.push(dir);
  return dir;
}

function runGit(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...GIT_ENV, ...env } });
}

function makeRepo(): string {
  const repo = makeTempDir();
  runGit(repo, ["init", "-q", "-b", "main"]);
  return repo;
}

function commitFile(repo: string, path: string, lines: string[], env: Record<string, string> = {}): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), lines.join("\n") + "\n");
  runGit(repo, ["add", path]);
  runGit(repo, ["commit", "-q", "-m", `add ${path}`], env);
}

function codeLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `export const value${i} = ${i};`);
}

function commentLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `// comment ${i}`);
}

function runCli(cwd: string, args: string[] = []): string {
  return execFileSync(CLI_PATH, args, { cwd, encoding: "utf8", env: GIT_ENV }).trimEnd();
}

describe("cli", () => {
  test("measures HEAD by default", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", codeLines(30));
    assert.equal(runCli(repo), "status=ok 0% of added code lines are comments (0 of 30)");
  });

  test("--commit <ref> measures that commit and prints the commit message", () => {
    const repo = makeRepo();
    commitFile(repo, "src/heavy.ts", [...commentLines(10), ...codeLines(20)]);
    commitFile(repo, "src/clean.ts", codeLines(30));
    const output = runCli(repo, ["--commit", "HEAD~1"]);
    assert.ok(output.startsWith("status=alert 33% of added code lines are comments (10 of 30)\n\nWarning: "));
    assert.ok(output.includes("in this commit.\n"));
    assert.ok(output.includes("Remove at least 10 of the 10 added comment lines"));
    assert.ok(output.includes("git commit --amend --no-edit"));
  });

  test("--branch falls back to origin/main and measures only the branch's commits", () => {
    const repo = makeRepo();
    commitFile(repo, "src/base.ts", [...commentLines(50), ...codeLines(50)]);
    runGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    commitFile(repo, "src/feature.ts", [...commentLines(5), ...codeLines(25)]);
    const output = runCli(repo, ["--branch"]);
    assert.ok(output.startsWith("status=alert 17% of added code lines are comments (5 of 30)\n"));
    assert.ok(output.includes("in this branch."));
    assert.ok(output.includes("Fold the removals into the commits that added them"));
  });

  test("--branch prefers origin/master over origin/main", () => {
    const repo = makeRepo();
    commitFile(repo, "src/base.ts", codeLines(10));
    runGit(repo, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
    commitFile(repo, "src/middle.ts", codeLines(30));
    runGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    commitFile(repo, "src/top.ts", codeLines(20));
    assert.equal(runCli(repo, ["--branch"]), "status=ok 0% of added code lines are comments (0 of 50)");
  });

  test("--branch --base <ref> measures against that ref", () => {
    const repo = makeRepo();
    commitFile(repo, "src/base.ts", codeLines(10));
    runGit(repo, ["checkout", "-q", "-b", "feature"]);
    commitFile(repo, "src/feature.ts", codeLines(25));
    assert.equal(
      runCli(repo, ["--branch", "--base", "main"]),
      "status=ok 0% of added code lines are comments (0 of 25)",
    );
  });

  test("measures a file whose path is not ASCII", () => {
    const repo = makeRepo();
    commitFile(repo, "src/caf\u00e9.ts", [...commentLines(5), ...codeLines(20)]);
    assert.ok(runCli(repo).startsWith("status=alert 20% of added code lines are comments (5 of 25)\n"));
  });

  test("measures a diff larger than 1 MiB", () => {
    const repo = makeRepo();
    commitFile(repo, "src/big.ts", codeLines(100_000));
    assert.equal(runCli(repo), "status=ok 0% of added code lines are comments (0 of 100000)");
  });

  test("outside a repo prints git's error and exits 0", () => {
    assert.match(runCli(makeTempDir()), /^status=error fatal: not a git repository/);
  });

  test("an unknown ref prints git's error and exits 0", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", codeLines(1));
    assert.match(runCli(repo, ["--commit", "nope"]), /^status=error fatal: /);
  });

  test("--branch with no origin/master or origin/main says so", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", codeLines(1));
    assert.equal(
      runCli(repo, ["--branch"]),
      "status=error no --base given and neither origin/master nor origin/main exists",
    );
  });

  test("bad arguments print usage, including a ref that looks like a flag", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", codeLines(1));
    for (const args of [["--wat"], ["--commit", "--stat"], ["--branch", "--base"], ["--commit", "a", "b"]]) {
      assert.match(runCli(repo, args), /^status=error usage: comment-density/, args.join(" "));
    }
  });
});

function writeFile(repo: string, path: string, lines: string[]): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), lines.join("\n") + "\n");
}

function slashLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `// css text ${i}`);
}

// Line 2 of the new file opens a template literal; a separate hunk further down adds
// lines inside it that start with //, so they are string content, not comments.
function literalVersion(): string[] {
  const lines = codeLines(30);
  lines[1] = "const STYLES = `";
  lines.splice(25, 0, ...slashLines(25), "`;");
  return lines;
}

describe("cli: post-images, --staged and --warn", () => {
  test("--staged measures the index, not unstaged edits", () => {
    const repo = makeRepo();
    commitFile(repo, "src/base.ts", codeLines(1));
    writeFile(repo, "src/a.ts", [...commentLines(10), ...codeLines(20)]);
    runGit(repo, ["add", "src/a.ts"]);
    writeFile(repo, "src/a.ts", [...commentLines(40), ...codeLines(20)]);
    assert.match(runCli(repo, ["--staged"]), /^status=alert 33% of added code lines are comments \(10 of 30\)\n/);
  });

  test("--staged reads post-images from the index", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", codeLines(30));
    writeFile(repo, "src/a.ts", literalVersion());
    runGit(repo, ["add", "src/a.ts"]);
    writeFile(repo, "src/a.ts", codeLines(30));
    assert.equal(runCli(repo, ["--staged"]), "status=ok 0% of added code lines are comments (0 of 27)");
  });

  test("--commit reads post-images at that commit", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", codeLines(30));
    commitFile(repo, "src/a.ts", literalVersion());
    assert.equal(runCli(repo, ["--commit", "HEAD"]), "status=ok 0% of added code lines are comments (0 of 27)");
  });

  test("--branch reads post-images at HEAD", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", codeLines(30));
    runGit(repo, ["branch", "base"]);
    commitFile(repo, "src/a.ts", literalVersion());
    assert.equal(
      runCli(repo, ["--branch", "--base", "base"]),
      "status=ok 0% of added code lines are comments (0 of 27)",
    );
  });

  test("post-images resolve from the repo root when run in a subdirectory", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", codeLines(30));
    commitFile(repo, "src/a.ts", literalVersion());
    assert.equal(runCli(join(repo, "src")), "status=ok 0% of added code lines are comments (0 of 27)");
  });

  test("--warn moves the warn and alert lines, in any argument position", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", [...commentLines(3), ...codeLines(97)]);
    assert.equal(runCli(repo), "status=ok 3% of added code lines are comments (3 of 100)");
    assert.match(runCli(repo, ["--warn", "2"]), /^status=warn 3% /);
    assert.match(runCli(repo, ["--commit", "HEAD", "--warn", "2"]), /^status=warn 3% /);
    assert.match(runCli(repo, ["--warn", "1"]), /^status=alert 3% /);
  });

  test("--warn sets the message's target", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", [...commentLines(3), ...codeLines(97)]);
    assert.ok(
      runCli(repo, ["--warn", "2"]).includes("Remove at least 2 of the 3 added comment lines to get under 2%."),
    );
  });

  test("--staged takes --warn in the hook's argument order", () => {
    const repo = makeRepo();
    commitFile(repo, "src/base.ts", codeLines(1));
    writeFile(repo, "src/a.ts", [...commentLines(3), ...codeLines(97)]);
    runGit(repo, ["add", "src/a.ts"]);
    assert.match(runCli(repo, ["--staged", "--warn", "2"]), /^status=warn 3% of added code lines are comments \(3 of 100\)\n/);
  });

  test("--staged skips a merge commit, whose index holds the other branch's changes", () => {
    const repo = makeRepo();
    commitFile(repo, "src/shared.ts", codeLines(1));
    runGit(repo, ["branch", "feature"]);
    commitFile(repo, "src/shared.ts", ["export const fromMain = 1;"]);
    commitFile(repo, "src/heavy.ts", [...commentLines(10), ...codeLines(20)]);
    runGit(repo, ["switch", "-q", "feature"]);
    commitFile(repo, "src/shared.ts", ["export const fromFeature = 1;"]);
    assert.throws(() => runGit(repo, ["merge", "-q", "main"]));
    writeFile(repo, "src/shared.ts", ["export const resolved = 1;"]);
    runGit(repo, ["add", "src/shared.ts"]);
    assert.equal(runCli(repo, ["--staged"]), "status=ok merge commit not measured");
  });

  test("an invalid --warn value is an error, not the default", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", codeLines(1));
    for (const args of [["--warn", "abc"], ["--warn"], ["--warn", "0"], ["--warn", "-1"], ["--warn", "2%"]]) {
      assert.equal(runCli(repo, args), "status=error invalid --warn value", args.join(" "));
    }
  });
});

const HOOK_PATH = fileURLToPath(new URL("./claudeHook.mts", import.meta.url));

function commitInput(cwd: string, command = 'git commit -m "add things"') {
  return { cwd, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } };
}

function heavyRepo(): string {
  const repo = makeRepo();
  commitFile(repo, "src/a.ts", [...commentLines(10), ...codeLines(20)]);
  return repo;
}

describe("handleHook", () => {
  const measured = [
    'git commit -m "x"',
    "git commit --amend --no-edit",
    'git add -A && git commit -m "x"',
    "cd repo && git commit -qm x",
    "git -c commit.gpgsign=false commit -m x",
    "git commit -m x && npm test -- --dry-run",
  ];
  const ignored = ["git status", "git commit --dry-run", "git commit-tree HEAD^{tree}", "echo hi"];

  for (const command of measured) {
    test(`warns after: ${command}`, () => assert.ok(handleHook(commitInput(heavyRepo(), command))));
  }
  for (const command of ignored) {
    test(`ignores: ${command}`, () => assert.equal(handleHook(commitInput(heavyRepo(), command)), null));
  }

  test("ignores a HEAD older than 120 seconds, so a failed commit doesn't re-measure it", () => {
    assert.equal(handleHook(commitInput(heavyRepo()), Date.now() + 121_000), null);
  });

  test("measures an amend of an old commit, because amend refreshes the committer time", () => {
    const repo = makeRepo();
    const old = { GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };
    commitFile(repo, "src/a.ts", [...commentLines(10), ...codeLines(20)], old);
    assert.equal(handleHook(commitInput(repo)), null);
    runGit(repo, ["commit", "-q", "--amend", "--no-edit"]);
    assert.ok(handleHook(commitInput(repo, "git commit --amend --no-edit")));
  });

  test("stays quiet for a commit under the threshold", () => {
    const repo = makeRepo();
    commitFile(repo, "src/a.ts", codeLines(30));
    assert.equal(handleHook(commitInput(repo)), null);
  });

  test("hands the agent the CLI's warning and shows the status line", () => {
    const output = handleHook(commitInput(heavyRepo()));
    assert.ok(output);
    assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.ok(output.hookSpecificOutput.additionalContext.includes("git commit --amend --no-edit"));
    assert.equal(
      output.systemMessage,
      "comment-density: status=alert 33% of added code lines are comments (10 of 30)",
    );
  });
});

describe("claudeHook main", () => {
  function runHook(stdin: string): string {
    return execFileSync(process.execPath, [HOOK_PATH], { input: stdin, encoding: "utf8", env: GIT_ENV });
  }

  test("prints hook JSON for a comment-heavy commit", () => {
    const output = JSON.parse(runHook(JSON.stringify(commitInput(heavyRepo()))));
    assert.match(output.systemMessage, /^comment-density: status=alert/);
  });

  test("stays silent and exits 0 on bad input, outside a repo, and in a repo with no commits", () => {
    assert.equal(runHook("not json"), "");
    assert.equal(runHook("null"), "");
    assert.equal(runHook(JSON.stringify({ tool_input: "git commit" })), "");
    assert.equal(runHook(JSON.stringify(commitInput(makeTempDir()))), "");
    assert.equal(runHook(JSON.stringify(commitInput(makeRepo()))), "");
  });
});
