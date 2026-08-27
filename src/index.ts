#!/usr/bin/env node
/**
 * tether — a $0 agentic coding CLI on top of OpenRouter's free models.
 *
 * Commands:
 *   tether                  interactive session in the current directory
 *   tether run "<task>"     one-shot task, then exit
 *   tether models           show the current free coding model ranking
 *   tether watch            poll the ranking on a schedule and print changes
 */

import * as readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { Agent } from "./agent.js";
import { OpenRouterClient } from "./openrouter.js";
import { ModelScout, RankedModel } from "./scout.js";
import { color, formatContext, Spinner } from "./ui.js";

const VERSION = "0.1.0";
const DEFAULT_POLL_MINUTES = 10;

const HELP = `tether v${VERSION} — $0 agentic coding on OpenRouter's free models

Usage:
  tether [options]              interactive session in the current directory
  tether run "<task>" [options] run one task and exit
  tether models                 show the current free coding model ranking
  tether watch [options]        poll the ranking on a schedule, print changes

Options:
  --model <id>    pin a specific model (disables scouting/failover)
  --poll <min>    ranking poll interval in minutes (default ${DEFAULT_POLL_MINUTES})
  --yolo          run shell commands without asking for approval
  -h, --help      show this help
  -v, --version   show version

Environment:
  OPENROUTER_API_KEY   required for chat (free at https://openrouter.ai/keys)

Slash commands (interactive): /models /model <id> /clear /help /exit
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      model: { type: "string" },
      poll: { type: "string" },
      yolo: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(VERSION);

  const pollMinutes = Number(
    values.poll ?? process.env.TETHER_POLL_MINUTES ?? DEFAULT_POLL_MINUTES,
  );
  if (!Number.isFinite(pollMinutes) || pollMinutes <= 0) {
    fail("--poll must be a positive number of minutes");
  }

  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY);
  const scout = new ModelScout(client, values.model);
  const command = positionals[0] ?? "chat";

  switch (command) {
    case "models":
      return showModels(scout);
    case "watch":
      return watch(scout, pollMinutes);
    case "run": {
      const task = positionals.slice(1).join(" ").trim();
      if (!task) fail('usage: tether run "<task>"');
      return runSession(client, scout, pollMinutes, values.yolo, task);
    }
    case "chat":
      return runSession(client, scout, pollMinutes, values.yolo);
    default:
      fail(`unknown command "${command}"\n\n${HELP}`);
  }
}

function fail(message: string): never {
  console.error(color.red(message));
  process.exit(1);
}

function printRanking(models: readonly RankedModel[]): void {
  if (models.length === 0) {
    console.log(color.yellow("no free tool-calling models found right now"));
    return;
  }
  const idWidth = Math.max(...models.map((m) => m.id.length));
  models.forEach((m, i) => {
    const pick = i === 0 ? color.green("▶") : " ";
    const rank =
      m.codingRank !== undefined
        ? color.cyan(`#${m.codingRank + 1} coding this week`)
        : color.dim("unranked for coding");
    console.log(
      `${pick} ${String(i + 1).padStart(2)}. ${m.id.padEnd(idWidth)}  ${color.dim(formatContext(m.contextLength).padStart(5) + " ctx")}  ${rank}`,
    );
  });
}

async function refreshWithSpinner(scout: ModelScout): Promise<void> {
  const spinner = new Spinner();
  spinner.start("scouting free coding models on OpenRouter");
  try {
    await scout.refresh();
  } finally {
    spinner.stop();
  }
}

async function showModels(scout: ModelScout): Promise<void> {
  await refreshWithSpinner(scout);
  printRanking(scout.models);
  console.log(color.dim("\n▶ = current pick · free tool-calling models, best coding option first"));
}

async function watch(scout: ModelScout, pollMinutes: number): Promise<void> {
  await refreshWithSpinner(scout);
  console.log(color.bold(`[${new Date().toLocaleTimeString()}] initial ranking:`));
  printRanking(scout.models);
  console.log(color.dim(`\npolling every ${pollMinutes}m — ctrl+c to stop`));

  scout.startPolling(pollMinutes * 60_000, (best) => {
    console.log(
      `${color.bold(`[${new Date().toLocaleTimeString()}]`)} ${color.green("best model changed →")} ${best.id}`,
    );
    printRanking(scout.models);
  });
  // The interval timer keeps the process alive until ctrl+c.
  await new Promise(() => {});
}

async function runSession(
  client: OpenRouterClient,
  scout: ModelScout,
  pollMinutes: number,
  yolo: boolean,
  oneShotTask?: string,
): Promise<void> {
  if (!client.hasKey) {
    fail(
      "OPENROUTER_API_KEY is not set.\n" +
        "Create a free key at https://openrouter.ai/keys and export it:\n" +
        "  export OPENROUTER_API_KEY=sk-or-...",
    );
  }

  if (!scout.isPinned) await refreshWithSpinner(scout);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const approveCommand = async (command: string): Promise<boolean> => {
    if (yolo) return true;
    if (!process.stdin.isTTY) {
      console.log(
        color.yellow("⚠ no TTY to approve shell command; declining (use --yolo to auto-approve)"),
      );
      return false;
    }
    const answer = await rl.question(
      `${color.yellow("run?")} ${color.bold(command)} ${color.dim("[y/N]")} `,
    );
    return /^y(es)?$/i.test(answer.trim());
  };

  const agent = new Agent({ client, scout, toolContext: { cwd: process.cwd(), approveCommand } });

  // Re-scout on a schedule; a better model takes over on the next request.
  scout.startPolling(pollMinutes * 60_000, (best) => {
    console.log(color.dim(`● scout: ${best.id} is now the best free coding model; switching`));
  });

  if (oneShotTask) {
    try {
      await agent.runTurn(oneShotTask);
    } finally {
      rl.close();
      scout.stopPolling();
    }
    return;
  }

  const best = scout.pick();
  console.log(
    color.bold(`tether v${VERSION}`) + color.dim(` — free agentic coding · ${process.cwd()}`),
  );
  console.log(
    color.dim(
      `model: ${best?.id ?? "none"} · re-scouting every ${pollMinutes}m · /help for commands`,
    ),
  );

  while (true) {
    let input: string;
    try {
      input = (await rl.question(color.cyan("\n❯ "))).trim();
    } catch {
      break; // stdin closed (ctrl+d)
    }
    if (!input) continue;

    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.split(/\s+/);
      if (cmd === "/exit" || cmd === "/quit") break;
      if (cmd === "/help") {
        console.log(HELP);
      } else if (cmd === "/clear") {
        agent.reset();
        console.log(color.dim("conversation cleared"));
      } else if (cmd === "/models") {
        await refreshWithSpinner(scout);
        printRanking(scout.models);
      } else if (cmd === "/model") {
        const id = rest.join(" ");
        if (id) {
          console.log(color.dim(`pinning ${id} for this session`));
          scout.pin(id);
        } else {
          console.log(`current: ${scout.pick()?.id ?? "none"}${scout.isPinned ? " (pinned)" : ""}`);
        }
      } else {
        console.log(color.yellow(`unknown command ${cmd} — try /help`));
      }
      continue;
    }

    try {
      await agent.runTurn(input);
    } catch (err) {
      console.error(color.red(`\nerror: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  rl.close();
  scout.stopPolling();
}

main().catch((err) => {
  console.error(color.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
