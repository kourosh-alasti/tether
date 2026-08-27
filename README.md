# tether

A $0 agentic coding CLI. Tether combines verified-free models from
[OpenRouter](https://openrouter.ai) and
[Vercel AI Gateway](https://vercel.com/ai-gateway), then uses them to run
tool-calling agent workflows (read/edit files, search, run commands) in your
terminal. Vercel requests run through the
[Vercel AI SDK](https://ai-sdk.dev).

## How it picks the model

There is no hardcoded model list. On startup — and then on a schedule — Tether
queries every connected provider:

1. `GET /models?supported_parameters=tools` — every model that supports tool calling; only `:free` variants with all-zero pricing are kept.
2. `GET /models?category=programming&sort=top-weekly` — OpenRouter's own ranking of coding models by real usage this week.
3. Vercel AI Gateway's model catalog — only language models whose id ends in
   `-free`, whose catalog includes the `free` tag and tool support, and whose
   pricing is empty or all zero are kept. These ids are Vercel's synthetic
   free-tier routes.

A free OpenRouter model whose base slug appears in the coding ranking inherits
that position; the rest are ordered by context length and recency. When both
providers are connected, `tether models` displays one combined list with
provider-qualified selectors such as `openrouter:vendor/model:free` and
`vercel:vendor/model-free`. Failover can cross provider boundaries.

Tether fails closed: `--model` and `/model` can only select an entry that was
just verified in a live free catalog, and both request clients reject model ids
without their provider's free suffix. Paid catalog models are never eligible.

## Setup

Requires Node 22+. Install the CLI, then connect either or both providers:

```bash
pnpm install
pnpm build
pnpm link --global
tether login                 # choose a provider interactively
tether login openrouter      # OpenRouter OAuth PKCE
tether login vercel          # paste a Vercel AI Gateway API key
```

`tether login openrouter` uses OAuth PKCE (S256), opens OpenRouter in your browser, and
receives the one-time authorization code on an ephemeral localhost port. On
SSH servers or in containers, use `tether login openrouter --headless` and paste the
one-time code shown by OpenRouter. The resulting API key is saved under
`~/.config/tether/auth.json` with user-only permissions.

`tether login vercel` opens AI Gateway, asks for an API key, validates it
against the model catalog, and stores it in the same file. `OPENROUTER_API_KEY`
and `AI_GATEWAY_API_KEY` take precedence over saved credentials.

## Usage

```bash
tether                      # interactive session in the current directory
tether run "fix the failing test in src/parser.ts"
tether models               # show the current free coding model ranking
tether watch                # poll the ranking on a schedule, print changes
tether login openrouter --headless
tether login vercel
tether logout openrouter    # remove one provider credential
tether logout vercel
tether whoami               # show every connected provider
tether help                 # list every command and option
```

Options:

| Flag                    | Effect                                                                  |
| ----------------------- | ----------------------------------------------------------------------- |
| `--model <provider:id>` | pin a verified-free listed model; disables failover                     |
| `--poll <min>`          | ranking poll interval in minutes (default 10, or `TETHER_POLL_MINUTES`) |
| `--yolo`                | run shell commands without asking for approval                          |

Inside an interactive session, `/model` opens a numbered picker containing the
current free models in coding-rank order. `/model <number|id>` switches
directly; `/auto` resumes scheduled selection and failover. Other commands:
`/models`, `/status`, `/whoami`, `/pwd`, `/clear`, `/help`, and `/exit`.

## Agent tools

The model gets six tools: `read_file`, `write_file`, `edit_file` (exact-string replace), `list_dir`, `grep`, and `bash`. File tools are confined to the working directory. Every shell command is shown to you for y/N approval unless you pass `--yolo`.

## The zero-charge rule

Tether does not treat promotional credits on ordinarily paid model ids as
"free." It only sends requests to explicit free routes:

- OpenRouter: an id ending in `:free` with explicit zero prompt and completion
  prices (and no non-zero ancillary price);
- Vercel: a synthetic id ending in `-free`, tagged `free`, tool-capable, and
  carrying no non-zero catalog price.

Manual model pinning cannot bypass these checks. If a provider stops advertising
a route as free, it disappears on the next catalog refresh and cannot be used.
When the free allowance is exhausted, Tether surfaces the provider error; it
does not fall back to a paid id.

OpenRouter rate-limits its free variants:

- roughly 20 requests/minute across free models;
- **50 free requests/day** if you've never bought credits, raised to **1000/day** once you've purchased at least $10 of credits (one-time top-up — you still pay nothing per request).

Agentic loops make one request per step, so a long task can burn through the
allowance quickly. Vercel free-tier routes also have per-model limits. Tether
can fail over to another verified-free route, but it never upgrades to a paid
route.

Free endpoints may have provider-specific data retention or training policies.
Check the selected route's policy before pointing Tether at code you cannot
share.

## Development

```bash
pnpm dev
pnpm typecheck
```
