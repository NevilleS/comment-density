// Port of PostHog's .github/scripts/check_comment_density.py (MIT); see README.md for credit.

export type CommentDensityStatus = "ok" | "warn" | "alert";

export type FileCommentDensity = {
  path: string;
  addedCodeLines: number;
  addedCommentLines: number;
};

export type CommentDensityReport = {
  addedCodeLines: number;
  addedCommentLines: number;
  ratio: number;
  status: CommentDensityStatus;
  files: FileCommentDensity[];
};

export type Thresholds = {
  warnRatio: number;
  alertRatio: number;
  minAddedCodeLines: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = { warnRatio: 0.03, alertRatio: 0.06, minAddedCodeLines: 20 };

const HASH_LANGS = new Set(["py", "pyi", "rb"]);
const SLASH_LANGS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "rs", "go", "kt", "java", "swift", "c", "h", "cpp", "hog",
]);
const SQL_LANGS = new Set(["sql"]);

const EXCLUDED_PATHS =
  /(^\.github\/|(?:^|\/)(?:generated[_./]|_generated_)|\.generated\.|__snapshots__\/|\.ambr$|\.snap$|\.lock$|migrations\/\d|\.min\.js$|\/dist\/|\/vendor\/|\/node_modules\/|_pb2|\.d\.ts$)/;
const DIFF_SKIP_PREFIXES = ["+++", "---", "index ", "new file", "deleted file", "similarity", "rename ", "Binary"];

// The original splits with Python's str.splitlines() and trims with str.strip(); matching
// both keeps line counts identical to it.
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const PYTHON_WHITESPACE = "[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PYTHON_STRIP = new RegExp(`^${PYTHON_WHITESPACE}+|${PYTHON_WHITESPACE}+$`, "g");

type ParserState = "block_comment" | "template_literal" | "triple_string" | null;

export type PostImageLookup = (path: string) => string | undefined;

const HUNK_NEW_START = /^@@ -\d+(?:,\d+)? \+(\d+)/;

type PrefixScan = { lines: string[]; scanned: number; state: ParserState };

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function isEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && line[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

function countOccurrences(line: string, needle: string): number {
  return line.split(needle).length - 1;
}

function slashStateAfterLine(line: string, initial: ParserState): ParserState {
  let state = initial;
  let quote = "";
  let index = 0;

  while (index < line.length) {
    if (state === "block_comment") {
      if (line.startsWith("*/", index)) {
        state = null;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (state === "template_literal") {
      if (line[index] === "`" && !isEscaped(line, index)) state = null;
      index += 1;
      continue;
    }

    if (quote) {
      if (line[index] === quote && !isEscaped(line, index)) quote = "";
      index += 1;
      continue;
    }

    if (line.startsWith("//", index)) return null;
    if (line.startsWith("/*", index)) {
      state = "block_comment";
      index += 2;
      continue;
    }
    if (line[index] === "'" || line[index] === '"') quote = line[index];
    else if (line[index] === "`") state = "template_literal";
    index += 1;
  }

  return state;
}

function classifySlash(line: string, state: ParserState): [boolean, ParserState] {
  if (state === "template_literal") return [false, slashStateAfterLine(line, state)];

  if (state === "block_comment" || line.startsWith("/*") || line.startsWith("{/*")) {
    const end = line.indexOf("*/");
    const isComment = end === -1 || line.slice(end + 2).replace(/^[ }]+|[ }]+$/g, "") === "";
    return [isComment, slashStateAfterLine(line, state)];
  }

  if (line.startsWith("//")) return [true, null];

  return [false, slashStateAfterLine(line, state)];
}

function classifyHash(line: string, state: ParserState): [boolean, ParserState] {
  const toggles = (countOccurrences(line, '"""') + countOccurrences(line, "'''")) % 2 === 1;
  if (state === "triple_string") return [false, toggles ? null : state];
  const isComment = line.startsWith("#") && !line.startsWith("#!");
  return [isComment, toggles ? "triple_string" : null];
}

function classify(lang: string, line: string, state: ParserState): [boolean, ParserState] {
  if (SLASH_LANGS.has(lang)) return classifySlash(line, state);
  if (HASH_LANGS.has(lang)) return classifyHash(line, state);
  if (SQL_LANGS.has(lang)) return [line.startsWith("--"), null];
  return [false, null];
}

// Hunks arrive in ascending order, so one forward scan per file serves all of them.
// Lines are numbered on "\n" as git numbers them, then split like the diff loop splits.
function stateBeforeLine(lang: string, scan: PrefixScan, lineNumber: number): ParserState {
  for (; scan.scanned < Math.min(lineNumber - 1, scan.lines.length); scan.scanned++) {
    for (const piece of scan.lines[scan.scanned].split(LINE_BREAK)) {
      const line = piece.replace(PYTHON_STRIP, "");
      if (line) scan.state = classify(lang, line, scan.state)[1];
    }
  }
  return scan.state;
}

function isCodeLang(lang: string): boolean {
  return SLASH_LANGS.has(lang) || HASH_LANGS.has(lang) || SQL_LANGS.has(lang);
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function measureCommentDensity(
  diff: string,
  thresholds: Partial<Thresholds> = {},
  postImage?: PostImageLookup,
): CommentDensityReport {
  const { warnRatio, alertRatio, minAddedCodeLines } = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const files = new Map<string, FileCommentDensity>();
  let addedCodeLines = 0;
  let addedCommentLines = 0;
  let path = "";
  let lang = "";
  let stats: FileCommentDensity | null = null;
  let state: ParserState = null;
  let scan: PrefixScan | null | undefined;

  for (const raw of diff.split(LINE_BREAK)) {
    if (raw.startsWith("diff --git ")) {
      const pathStart = raw.indexOf(" b/");
      path = pathStart === -1 ? raw : raw.slice(pathStart + 3);
      lang = extension(path);
      stats = null;
      state = null;
      scan = undefined;
      if (isCodeLang(lang) && !EXCLUDED_PATHS.test(path)) {
        stats = files.get(path) ?? { path, addedCodeLines: 0, addedCommentLines: 0 };
        files.set(path, stats);
      }
      continue;
    }
    if (raw.startsWith("@@")) {
      // A hunk can open inside a string or comment that began above it; only the
      // new file knows. Without it, assume top level, as PostHog does.
      state = null;
      const start = Number(HUNK_NEW_START.exec(raw)?.[1] ?? 0);
      if (stats !== null && postImage && start > 1) {
        if (scan === undefined) {
          const text = postImage(path);
          scan = text === undefined ? null : { lines: text.split("\n"), scanned: 0, state: null };
        }
        if (scan) state = stateBeforeLine(lang, scan, start);
      }
      continue;
    }
    if (stats === null || DIFF_SKIP_PREFIXES.some((prefix) => raw.startsWith(prefix))) continue;
    // Context lines are part of the new file too, so they move the state;
    // removed lines are not and are skipped entirely.
    const added = raw.startsWith("+");
    if (!added && !raw.startsWith(" ")) continue;
    const line = raw.slice(1).replace(PYTHON_STRIP, "");
    if (!line) continue;

    const [isComment, nextState] = classify(lang, line, state);
    state = nextState;
    if (!added) continue;

    stats.addedCodeLines++;
    addedCodeLines++;
    if (isComment) {
      stats.addedCommentLines++;
      addedCommentLines++;
    }
  }

  const ratio = addedCodeLines ? addedCommentLines / addedCodeLines : 0;
  const status: CommentDensityStatus =
    addedCodeLines < minAddedCodeLines || ratio <= warnRatio ? "ok" : ratio > alertRatio ? "alert" : "warn";

  return {
    addedCodeLines,
    addedCommentLines,
    ratio,
    status,
    files: [...files.values()]
      .filter((file) => file.addedCodeLines > 0)
      .sort((a, b) => b.addedCommentLines - a.addedCommentLines || comparePaths(a.path, b.path)),
  };
}

function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

export function renderSummary(report: CommentDensityReport): string {
  const percent = roundHalfToEven(100 * report.ratio);
  return `${percent}% of added code lines are comments (${report.addedCommentLines} of ${report.addedCodeLines})`;
}

export function renderStatusLine(report: CommentDensityReport): string {
  return `status=${report.status} ${renderSummary(report)}`;
}

export type MessageMode = "commit" | "branch";

const TOP_FILES = 8;

export function renderAgentMessage(
  report: CommentDensityReport,
  mode: MessageMode,
  warnRatio = DEFAULT_THRESHOLDS.warnRatio,
): string {
  const topFiles = report.files.filter((file) => file.addedCommentLines > 0).slice(0, TOP_FILES);
  const fileLines = topFiles.length
    ? [
        "",
        "Files with the most added comment lines:",
        ...topFiles.map((file) => `  ${file.path} (${file.addedCommentLines} of ${file.addedCodeLines})`),
      ]
    : [];
  const fixStep =
    mode === "commit"
      ? ["  5. Stage the files and run git commit --amend --no-edit, or make a follow-up commit."]
      : [
          "  5. Fold the removals into the commits that added them while the history is local;",
          "     otherwise make a follow-up commit.",
        ];

  return [
    `Warning: ${renderSummary(report)} in this ${mode}.`,
    "Before agent-assisted work, the typical share was about 2%.",
    ...fileLines,
    "",
    "If you are an AI coding agent, this warning is addressed to you. Do not skip it because",
    "the user did not mention comments: they asked for this check.",
    "",
    "Fix it now, before you do anything else:",
    "  1. Open each file listed above and read every comment line this diff adds.",
    "  2. Delete a comment that restates the code next to it, narrates the change",
    '     ("previously", "now we", "this fixes"), or says what a good name already says.',
    "  3. Keep a comment only when it states a reason the code cannot show: a workaround,",
    "     an ordering constraint, a spec quirk, or a link to the issue that forced it.",
    "  4. Do not reword the comments, shorten them, or move them into docstrings or JSDoc.",
    "     Remove them.",
    ...fixStep,
    "",
    `Remove at least ${linesToRemove(report, warnRatio)} of the ${report.addedCommentLines} added comment lines to get under ${Number((100 * warnRatio).toFixed(2))}%.`,
    "The target is the baseline, not a slightly smaller number. The full rules are in",
    "~/.claude/skills/writing-code-comments/SKILL.md.",
  ].join("\n");
}

function linesToRemove({ addedCommentLines, addedCodeLines }: CommentDensityReport, warnRatio: number): number {
  return Math.max(0, Math.ceil((addedCommentLines - warnRatio * addedCodeLines) / (1 - warnRatio)));
}
