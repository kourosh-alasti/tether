# tether CLI Documentation

A $0 agentic coding CLI that combines verified-free coding models from
OpenRouter and Vercel AI Gateway.

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
tether login                 # choose OpenRouter or Vercel interactively
tether login openrouter      # OpenRouter OAuth flow (opens browser)
tether login openrouter --headless
tether login vercel          # validate and save an AI Gateway API key
```

- On macOS: browser opens automatically
- On Linux: URL printed, `xdg-open` used if available
- On Windows: URL printed, `start` used if available

Saved credentials live in `~/.config/tether/auth.json` with user-only
permissions. Environment variables override each saved provider credential:

```bash
export OPENROUTER_API_KEY=your_key_here
export AI_GATEWAY_API_KEY=your_key_here
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

- `--model <provider:id>` — pin a listed verified-free model (disables failover)
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

Shows one current ranking of verified-free tool-calling models across all
connected providers. If both providers are logged in, both appear in the same
list.

```bash
tether models
```

Refreshes the catalog on each call. Outputs models sorted by:

1. OpenRouter weekly programming rank (free variants get that rank)
2. Context length (longer context preferred)
3. Recency (newer models preferred)

`▶` marks the current pick. Every selector is provider-qualified, for example
`openrouter:vendor/model:free` or `vercel:vendor/model-free`.

---

### `tether watch`

Polls the model ranking on a schedule and prints changes.

```bash
tether watch              # polls every 10 minutes (default)
tether watch --poll 5     # polls every 5 minutes
```

Press `ctrl+c` to stop. Shows a live ranking after each poll.

---

### `tether login [openrouter | vercel]`

Connects one provider. When the provider is omitted, Tether asks you to choose:

- **OpenRouter**: OAuth PKCE. `--headless` prints the authorization URL and asks
  for the returned one-time code.
- **Vercel**: opens AI Gateway and asks for an AI Gateway API key. Tether
  validates the key with the model catalog before saving it.

Saved to `~/.config/tether/auth.json`.

---

### `tether logout [openrouter | vercel]`

Removes one saved provider credential. If the provider is omitted, Tether asks
which one to remove.

```bash
tether logout openrouter
tether logout vercel
```

---

### `tether whoami`

Shows every connected provider. OpenRouter includes key tier and usage; Vercel
shows its connected status and the enforced synthetic-free-tier policy.

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
| `/whoami`             | Show connected providers and OpenRouter usage      |
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
| `OPENROUTER_API_KEY`  | Override saved OpenRouter login                   |
| `AI_GATEWAY_API_KEY`  | Override saved Vercel AI Gateway login            |
| `TETHER_POLL_MINUTES` | Override default poll interval (used by `--poll`) |
| `NO_COLOR`            | Disable ANSI colors                               |

### Polling Interval

Default is 10 minutes. Change with `--poll` flag or `TETHER_POLL_MINUTES` env var.

### Model Pinning

Use `--model <provider:id>` to pin a specific model. The selector must be in
the freshly loaded, verified-free catalog; arbitrary or paid ids are rejected.
This disables automatic failover. In an interactive session, resume automatic
selection with `/auto`.

---

## How Ranking Works

The scout queries every connected provider:

1. **Tool-capable free models** — models ending in `:free` with zero pricing, that support `tools`
2. **OpenRouter's weekly programming ranking** — `category=programming&sort=top-weekly`
3. **Vercel free-tier models** — language model ids ending in `-free` that are
   tagged `free`, support tools, and have no non-zero catalog pricing

A free model whose base slug (e.g., `anthropic/claude-3.5-sonnet:free`) appears in the programming ranking inherits that position. Free models outside the ranking come after, ordered by context length (longer preferred), then recency (newer preferred).

Models are re-polled every 10 minutes by default. On failure, the current model is benched for 90 seconds before the next-best model is tried.

Vercel completions use the Vercel AI SDK's AI Gateway provider. Models from
both providers share one ranking and one failover chain.

### Zero-charge invariant

Tether never uses ordinary paid model ids, including when an account has
promotional credits. OpenRouter models must have the `:free` suffix and
explicit zero prompt/completion/ancillary prices. Vercel models must have the
synthetic `-free` suffix, the `free` tag, tool support, and no non-zero price.
Catalog discovery, manual pinning, and the request clients all enforce the
rule. A catalog mismatch fails closed.

---

## Error Handling

- **Rate limits (429)**: If the error is daily-per-account, switching models won't help. The agent stops and reports the limit.
- **Model failures**: On retryable errors (404, 429, 5xx, etc.), the model is demoted and the next-best model is tried.
- **Daily cap**: Account-wide; OpenRouter reports it when a request exceeds the allowance.
- **No paid fallback**: Exhausted free limits are reported or retried against
  another verified-free model; Tether never sends a paid-model request.

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

`test/mock-server.mjs` provides mock OpenRouter and Vercel catalog responses,
plus an OpenRouter-compatible completion stream, for manual end-to-end testing.
