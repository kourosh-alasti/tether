# tether CLI Documentation

A $0 agentic coding CLI that uses OpenRouter's free coding models.

---

## Installation & Setup

```bash
git clone git@github.com:kourosh-alasti/tether.git
cd tether
pnpm install
pnpm build
pnpm link --global
```

### First-time Authentication

```bash
tether login           # interactive OAuth flow (opens browser)
tether login --headless  # print auth URL, paste code back in terminal
```

- On macOS: browser opens automatically
- On Linux: URL printed, `xdg-open` used if available
- On Windows: URL printed, `start` used if available

Set `OPENROUTER_API_KEY` environment variable to override saved credentials:

```bash
export OPENROUTER_API_KEY=your_key_here
```

---

## Commands

### `tether` / `tether chat`

Starts an interactive agentic coding session in the current directory.

**Features:**

- Automatic free-model selection and failover
- Model polling every 10 minutes (configurable with `--poll`)
- Tool usage: `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `bash`
- Slash commands (type `/help` within the session)

**Options:**

- `--model <id>` — pin a specific model (disables scouting/failover)
- `--poll <min>` — ranking poll interval in minutes (default: 10)
- `--yolo` — run shell commands without asking for approval

---

### `tether run "<task>"`

Runs one task and exits. The agent completes the task then exits.

```bash
tether run "refactor the auth logic in src/auth.ts"
```

Same options as `tether`: `--model`, `--poll`, `--yolo`.

---

### `tether models`

Shows the current ranking of free tool-calling models on OpenRouter.

```bash
tether models
```

Refreshes the catalog on each call. Outputs models sorted by:

1. OpenRouter weekly programming rank (free variants get that rank)
2. Context length (longer context preferred)
3. Recency ( newer models preferred)

`▶` marks the current pick.

---

### `tether watch`

Polls the model ranking on a schedule and prints changes.

```bash
tether watch              # polls every 10 minutes (default)
tether watch --poll 5     # polls every 5 minutes
```

Press `ctrl+c` to stop. Shows a live ranking after each poll.

---

### `tether login [--headless]`

Connects an OpenRouter account via OAuth PKCE.

- **Interactive** (default): opens browser, completes flow, saves credentials
- **`--headless`**: prints the authorization URL; paste the returned code into the terminal

Saved to `~/.config/tether/auth.json`.

---

### `tether logout`

Removes the saved OpenRouter login/credentials.

```bash
tether logout
```

---

### `tether whoami`

Shows the connected OpenRouter key, tier, and usage.

```
OpenRouter API key
tier: free / pay-as-you-go
usage today:   $XX.XXX
usage this week: $XX.XXX
usage this month: $XX.XXX
usage all time: $XX.XXX
key limit:     $XX.XXX (remaining: $XX.XXX) | none
limit reset:   YYYY-MM-DD
```

---

### `tether help`

Shows this help message.

---

### `tether --version` / `tether -v`

Shows the current version.

---

## Slash Commands (interactive session)

Type `/` followed by a command within an interactive `tether` session:

| Command               | Description                                        |
| --------------------- | -------------------------------------------------- |
| `/model`              | Show free-model list with current pick highlighted |
| `/model <number\|id>` | Switch to a specific model from the list           |
| `/models`             | Refresh and show sorted free models                |
| `/auto`               | Resume automatic model selection/failover          |
| `/status`             | Show current model and selection mode              |
| `/whoami`             | Show connected OpenRouter key and usage            |
| `/pwd`                | Show working directory                             |
| `/clear`              | Clear conversation history                         |
| `/help`               | Show this command list                             |
| `/exit`, `/quit`      | End the session                                    |

---

## Available Tools (model can use these)

The agent has access to the following tools during a session:

| Tool         | Description                                             |
| ------------ | ------------------------------------------------------- |
| `read_file`  | Read a file (up to 2000 lines, optional offset)         |
| `write_file` | Create or overwrite a file                              |
| `edit_file`  | Replace an exact string in a file                       |
| `list_dir`   | List files in a directory                               |
| `grep`       | Search file contents recursively with regex             |
| `bash`       | Run a shell command (requires approval unless `--yolo`) |

All tools are confined to the current working directory for safety.

---

## Configuration

### Environment Variables

| Variable              | Description                                       |
| --------------------- | ------------------------------------------------- |
| `OPENROUTER_API_KEY`  | Override saved OAuth login                        |
| `TETHER_POLL_MINUTES` | Override default poll interval (used by `--poll`) |
| `NO_COLOR`            | Disable ANSI colors                               |

### Polling Interval

Default is 10 minutes. Change with `--poll` flag or `TETHER_POLL_MINUTES` env var.

### Model Pinning

Use `--model <id>` to pin a specific model. This disables automatic scouting and failover. In an interactive session, resume automatic selection with `/auto`.

---

## How Ranking Works

The scout queries OpenRouter for:

1. **Tool-capable free models** — models ending in `:free` with zero pricing, that support `tools`
2. **OpenRouter's weekly programming ranking** — `category=programming&sort=top-weekly`

A free model whose base slug (e.g., `anthropic/claude-3.5-sonnet:free`) appears in the programming ranking inherits that position. Free models outside the ranking come after, ordered by context length (longer preferred), then recency (newer preferred).

Models are re-polled every 10 minutes by default. On failure, the current model is benched for 90 seconds before the next-best model is tried.

---

## Error Handling

- **Rate limits (429)**: If the error is daily-per-account, switching models won't help. The agent stops and reports the limit.
- **Model failures**: On retryable errors (404, 429, 5xx, etc.), the model is demoted and the next-best model is tried.
- **Daily cap**: Account-wide; OpenRouter reports it when a request exceeds the allowance.

---

## Development

### Building

```bash
pnpm build    # tsdown → dist/index.mjs
```

### Type Checking

```bash
pnpm typecheck
```

### Linting

```bash
pnpm lint     # oxlint
pnpm format   # oxfmt
```

### Testing

`test/mock-server.mjs` provides a local mock OpenRouter server for manual end-to-end testing.
