# tether

A $0 agentic coding CLI. Tether wraps [OpenRouter](https://openrouter.ai), continuously scouts for the **best free model for coding**, and uses it to run tool-calling agent workflows (read/edit files, search, run commands) in your terminal — like a codex/claude-code style CLI that costs nothing to run.

## How it picks the model

There is no hardcoded model list (it would go stale in weeks). On startup — and then on a schedule — tether cross-references two public OpenRouter catalog queries:

1. `GET /models?supported_parameters=tools` — every model that supports tool calling; only `:free` variants with all-zero pricing are kept.
2. `GET /models?category=programming&sort=top-weekly` — OpenRouter's own ranking of coding models by real usage this week.

A free model whose base slug appears in the coding ranking inherits that position; the rest are ordered by context length and recency. The top pick runs your session. If it gets rate-limited or its provider errors, it is benched for a cooldown and the next-best free model takes over mid-task. When a scheduled re-poll (default: every 10 minutes) finds a new best model, the session switches on the next request.

## Setup

Requires Node 22+. Install the CLI, then connect your OpenRouter account:

```bash
pnpm install
pnpm build
pnpm link --global
tether login
```

`tether login` uses OAuth PKCE (S256), opens OpenRouter in your browser, and
receives the one-time authorization code on an ephemeral localhost port. On
SSH servers or in containers, use `tether login --headless` and paste the
one-time code shown by OpenRouter. The resulting API key is saved under
`~/.config/tether/auth.json` with user-only permissions. `OPENROUTER_API_KEY`
still takes precedence when set, and `tether logout` removes the saved login.

## Usage

```bash
tether                      # interactive session in the current directory
tether run "fix the failing test in src/parser.ts"
tether models               # show the current free coding model ranking
tether watch                # poll the ranking on a schedule, print changes
tether login --headless     # authenticate from an SSH or container session
tether logout               # remove locally saved credentials
tether whoami               # show the connected key, tier, and usage
tether help                 # list every command and option
```

Options:

| Flag           | Effect                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| `--model <id>` | pin a specific model; disables scouting and failover                    |
| `--poll <min>` | ranking poll interval in minutes (default 10, or `TETHER_POLL_MINUTES`) |
| `--yolo`       | run shell commands without asking for approval                          |

Inside an interactive session, `/model` opens a numbered picker containing the
current free models in coding-rank order. `/model <number|id>` switches
directly; `/auto` resumes scheduled selection and failover. Other commands:
`/models`, `/status`, `/whoami`, `/pwd`, `/clear`, `/help`, and `/exit`.

## Agent tools

The model gets six tools: `read_file`, `write_file`, `edit_file` (exact-string replace), `list_dir`, `grep`, and `bash`. File tools are confined to the working directory. Every shell command is shown to you for y/N approval unless you pass `--yolo`.

## The fine print on "free"

Free model variants are genuinely $0, but OpenRouter rate-limits them:

- roughly 20 requests/minute across free models;
- **50 free requests/day** if you've never bought credits, raised to **1000/day** once you've purchased at least $10 of credits (one-time top-up — you still pay nothing per request).

Agentic loops make one request per step, so a long task can burn through the 50/day cap quickly. Tether fails over between free models when one is throttled, but the daily cap is account-wide — when you hit it, tether says so plainly instead of thrashing. The $10 top-up is the practical way to make this usable daily while still paying $0 per token.

Free endpoints may also train on your prompts (check each model's data policy on OpenRouter) — don't point this at code you can't share.

## Development

```bash
pnpm dev
pnpm typecheck
```
