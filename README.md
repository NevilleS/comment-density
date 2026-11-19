# comment-density

Measures how much of a diff's added code is full-line comments, and tells the agent to prune when it's too much. It runs on a commit or a whole branch in any git repo, and a Claude Code hook runs it after every `git commit` the agent makes.

Before agent-assisted work, the typical commit added about 2% comment lines. It warns above 3% and alerts above 6%, once a diff adds at least 20 code lines. It never blocks anything.

## Usage

```sh
comment-density                      # measures HEAD
comment-density --commit <ref>       # measures one commit
comment-density --branch             # measures <origin/master or origin/main>...HEAD
comment-density --branch --base <ref>  # on a stacked branch, pass the parent
comment-density --staged             # measures the index, for a pre-commit hook
comment-density --warn 5             # any mode: warn above 5%, alert above 10%
```

The first line is always `status=<ok|warn|alert|error> ...`. On warn or alert, a message for the agent follows. The exit code is always 0.

`--staged` skips merge commits and prints `status=ok merge commit not measured`: a conflicted merge stages the other branch's changes, which aren't the committer's to prune.

Each hunk is parsed from the state the new file is in where the hunk starts, read with `git show <ref>:<path>` (the index for `--staged`), so a hunk that opens inside a template literal or block comment is classified correctly.

## What counts

The denominator is added, non-blank lines in code files; the numerator is the ones that are full-line comments. Trailing comments, removed lines, docstrings, strings and template literals don't count. JSDoc and other `/* */` blocks do.

- `//` and `/* */`: ts, tsx, js, jsx, mjs, cjs, mts, cts, rs, go, kt, java, swift, c, h, cpp, hog
- `#`: py, pyi, rb
- `--`: sql

Generated files, snapshots, lockfiles, migrations, `dist/`, `vendor/`, `node_modules/`, `.d.ts` and `.github/` are left out.

Two known blind spots: a regex literal containing a quote or `//` can confuse the parser, and a reworded comment counts as a new one.

## Install as a Claude Code plugin

```sh
claude plugin marketplace add NevilleS/comment-density
claude plugin install comment-density@comment-density
```

Needs Node 22.18+ on the PATH, since it runs the `.mts` files directly. The plugin adds two hooks:

- **`PostToolUse` on Bash:** after a command that runs `git commit`, if HEAD in the session's directory landed in the last 120 seconds, it measures HEAD and hands any warning to the agent. It keeps no state. In shell terms:

  ```sh
  grep -q 'git.* commit' <<<"$cmd" && [ $(( $(date +%s) - $(git log -1 --format=%ct) )) -le 120 ] && comment-density | grep -v '^status=ok'
  ```

- **`SessionStart`:** tells the agent to run `comment-density --branch` before calling work finished.

The warning tells the agent to load a `writing-code-comments` skill for the full rules, if it has one. PostHog's is a good fit: [skills.sh/posthog/posthog/writing-code-comments](https://www.skills.sh/posthog/posthog/writing-code-comments).

To turn it off, `claude plugin uninstall comment-density`.

## Install by hand

To use the CLI outside Claude Code, link it onto your PATH:

```sh
ln -s ~/path/to/comment-density/cli.mts ~/.local/bin/comment-density
```

Tests: `node --test`.

## Credit

This is a port of PostHog's comment density check: the classifier rules, thresholds and warning text come from `.github/scripts/check_comment_density.py` and `check-comment-density.sh` in [PostHog/posthog](https://github.com/PostHog/posthog) at commit `8975d4bf584c0390f727515091a54b4d9a1e0b35`, used under the MIT license:

```
Copyright (c) 2020-2026 PostHog Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
