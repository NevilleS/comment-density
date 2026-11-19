#!/usr/bin/env bash
# The plugin's version of a CLAUDE.md rule: plugins can't add to CLAUDE.md, but
# a SessionStart hook's output reaches the agent the same way.
cat <<RULE
**Comment density before finishing.** Before you call a branch, PR or task finished, run \`node "${CLAUDE_PLUGIN_ROOT}/cli.mts" --branch\` (pass \`--base <parent>\` on a stacked branch). If it warns, prune comments until it's under the line, and fold the removals into the commits that added them. A hook also measures each commit you make, so treat its warning as a task, not a notice.
RULE
