#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  measureCommentDensity,
  renderAgentMessage,
  renderStatusLine,
  type MessageMode,
  type PostImageLookup,
  type Thresholds,
} from "./commentDensity.mts";

const DIFF_FLAGS = ["-U3", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
const USAGE = "usage: comment-density [--commit [<ref>] | --branch [--base <ref>] | --staged] [--warn <percent>]";

type Target = { mode: "commit"; ref: string } | { mode: "branch"; base?: string } | { mode: "staged" };

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function commitDiff(cwd: string, ref = "HEAD"): string {
  return git(cwd, ["show", ...DIFF_FLAGS, ref, "--"]);
}

export function branchDiff(cwd: string, base?: string): string {
  return git(cwd, ["diff", ...DIFF_FLAGS, `${base ?? defaultBase(cwd)}...HEAD`, "--"]);
}

export function stagedDiff(cwd: string): string {
  return git(cwd, ["diff", "--cached", ...DIFF_FLAGS, "--"]);
}

// `<revision>:<path>` resolves from the repo root, and an empty revision reads the index.
function postImageAt(cwd: string, revision: string): PostImageLookup {
  return (path) => {
    try {
      return git(cwd, ["show", `${revision}:${path}`]);
    } catch {
      return undefined;
    }
  };
}

function mergeInProgress(cwd: string): boolean {
  try {
    git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function defaultBase(cwd: string): string {
  for (const candidate of ["origin/master", "origin/main"]) {
    try {
      git(cwd, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
      return candidate;
    } catch {}
  }
  throw new Error("no --base given and neither origin/master nor origin/main exists");
}

function parseTarget(argv: string[]): Target {
  const isRef = (value: string | undefined) => value !== undefined && !value.startsWith("-");
  if (argv.length === 0) return { mode: "commit", ref: "HEAD" };
  if (argv[0] === "--commit" && argv.length === 1) return { mode: "commit", ref: "HEAD" };
  if (argv[0] === "--commit" && argv.length === 2 && isRef(argv[1])) return { mode: "commit", ref: argv[1] };
  if (argv[0] === "--branch" && argv.length === 1) return { mode: "branch" };
  if (argv[0] === "--branch" && argv[1] === "--base" && argv.length === 3 && isRef(argv[2])) {
    return { mode: "branch", base: argv[2] };
  }
  if (argv[0] === "--staged" && argv.length === 1) return { mode: "staged" };
  throw new Error(USAGE);
}

function parseWarn(argv: string[]): [string[], Partial<Thresholds>] {
  const at = argv.indexOf("--warn");
  if (at === -1) return [argv, {}];
  const value = argv[at + 1] ?? "";
  const percent = /^\d+(\.\d+)?$/.test(value) ? Number(value) : 0;
  if (percent <= 0) throw new Error("invalid --warn value");
  const rest = [...argv.slice(0, at), ...argv.slice(at + 2)];
  return [rest, { warnRatio: percent / 100, alertRatio: (2 * percent) / 100 }];
}

function errorReason(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text =
    typeof stderr === "string" && stderr.trim() ? stderr : error instanceof Error ? error.message : String(error);
  return text.trim().split("\n")[0];
}

export function run(argv: string[], cwd: string): string {
  try {
    const [rest, thresholds] = parseWarn(argv);
    const target = parseTarget(rest);
    if (target.mode === "staged" && mergeInProgress(cwd)) return "status=ok merge commit not measured";
    const [diff, revision] =
      target.mode === "commit"
        ? [commitDiff(cwd, target.ref), target.ref]
        : target.mode === "branch"
          ? [branchDiff(cwd, target.base), "HEAD"]
          : [stagedDiff(cwd), ""];
    const report = measureCommentDensity(diff, thresholds, postImageAt(cwd, revision));
    if (report.status === "ok") return renderStatusLine(report);
    const mode: MessageMode = target.mode === "branch" ? "branch" : "commit";
    return `${renderStatusLine(report)}\n\n${renderAgentMessage(report, mode, thresholds.warnRatio)}`;
  } catch (error) {
    return `status=error ${errorReason(error)}`;
  }
}

if (import.meta.main) {
  console.log(run(process.argv.slice(2), process.cwd()));
}
