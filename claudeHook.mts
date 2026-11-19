import { readFileSync } from "node:fs";
import { git, run } from "./cli.mts";

const GIT_COMMIT = /\bgit\b[^;&|\n]*\scommit(?![\w-])(?![^;&|\n]*--dry-run)/;
const FRESH_COMMIT_SECONDS = 120;

type HookInput = { cwd?: string; tool_input?: { command?: string } };

export function handleHook({ cwd, tool_input }: HookInput, now = Date.now()) {
  if (!cwd || !GIT_COMMIT.test(tool_input?.command ?? "")) return null;
  if (now / 1000 - Number(git(cwd, ["log", "-1", "--format=%ct"])) > FRESH_COMMIT_SECONDS) return null;
  const output = run([], cwd);
  if (!/^status=(warn|alert) /.test(output)) return null;
  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: output },
    systemMessage: `comment-density: ${output.split("\n")[0]}`,
  };
}

if (import.meta.main) {
  try {
    const output = handleHook(JSON.parse(readFileSync(0, "utf8")));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // A failing hook must never interrupt the agent's session.
  }
}
