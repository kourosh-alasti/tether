#!/usr/bin/env node
/**
 * tether — a $0 agentic coding CLI on top of OpenRouter's free models.
 *
 * Commands:
 *   tether                  interactive session in the current directory
 *   tether run "<task>"     one-shot task, then exit
 *   tether models           show the current free coding model ranking
 *   tether watch            poll the ranking on a schedule and print changes
 *   tether login            connect an OpenRouter account with OAuth PKCE
 *   tether whoami           show the connected OpenRouter key and usage
 */

import * as readline from "node:readline/promises";
import { parseArgs } from "node:util";

import { Agent } from "./agent.js";
import { authFilePath, getApiKey, login, logout } from "./auth.js";
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
  tether login [--headless]     connect to OpenRouter with OAuth PKCE
  tether logout                 remove the saved OpenRouter login
  tether whoami                 show the connected key, tier, and usage
  tether help                   show this help

Options:
  --model <id>    pin a specific model (disables scouting/failover)
  --poll <min>    ranking poll interval in minutes (default ${DEFAULT_POLL_MINUTES})
  --yolo          run shell commands without asking for approval
  --headless      copy/paste OAuth flow for SSH, containers, or remote hosts
  -h, --help      show this help
  -v, --version   show version

Environment:
  OPENROUTER_API_KEY   override the saved OAuth login

Slash commands (interactive): /model /models /auto /status /whoami /pwd /clear /help /exit
`;

const SLASH_HELP = `${color.bold("Interactive commands")}
  /model               choose from the sorted free-model list
  /model <number|id>   switch directly to a listed free model
  /models              refresh and show sorted free models
  /auto                resume automatic selection and failover
  /status              show the current model and selection mode
  /whoami              show the connected OpenRouter key and usage
  /pwd                 show the working directory
  /clear               clear conversation history
  /help                show this command list
  /exit, /quit         end the session`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      model: { type: "string" },
      poll: { type: "string" },
      yolo: { type: "boolean", default: false },
      headless: { type: "boolean", default: false },
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

  const command = positionals[0] ?? "chat";
  if (command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "login") {
    await login(values.headless);
    console.log(color.green(`✓ connected to OpenRouter\n  credentials: ${authFilePath()}`));
    return;
  }
  if (command === "logout") {
    const removed = await logout();
    console.log(removed ? color.green("✓ logged out") : color.dim("not logged in"));
    return;
  }

  const client = new OpenRouterClient(await getApiKey());
  if (command === "whoami") return showIdentity(client);

  const scout = new ModelScout(client, values.model);

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

async function showIdentity(client: OpenRouterClient): Promise<void> {
  if (!client.hasKey) {
    fail("Not connected to OpenRouter. Run `tether login` first.");
  }

  const key = await client.getKeyInfo();
  console.log(color.bold(key.label || "OpenRouter API key"));
  console.log(`tier:             ${key.is_free_tier ? "free" : "pay-as-you-go"}`);
  console.log(`usage today:      ${formatCredits(key.usage_daily)}`);
  console.log(`usage this week:  ${formatCredits(key.usage_weekly)}`);
  console.log(`usage this month: ${formatCredits(key.usage_monthly)}`);
  console.log(`usage all time:   ${formatCredits(key.usage)}`);
  if (key.limit !== null) {
    console.log(`key limit:        ${formatCredits(key.limit)}`);
    console.log(`limit remaining:  ${formatCredits(key.limit_remaining ?? 0)}`);
  } else {
    console.log("key limit:        none");
  }
  if (key.limit_reset) console.log(`limit reset:      ${key.limit_reset}`);
}

function formatCredits(value: number): string {
  return `$${value.toFixed(4)}`;
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
      "Not connected to OpenRouter.\n" +
        "Run `tether login` (or `tether login --headless` over SSH).\n" +
        "OPENROUTER_API_KEY remains available as an environment override.",
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
        console.log(SLASH_HELP);
      } else if (cmd === "/clear") {
        agent.reset();
        console.log(color.dim("conversation cleared"));
      } else if (cmd === "/models") {
        await refreshWithSpinner(scout);
        printRanking(scout.models);
      } else if (cmd === "/model") {
        await chooseModel(scout, rl, rest.join(" "));
      } else if (cmd === "/auto") {
        scout.useAutomatic();
        scout.startPolling(pollMinutes * 60_000, (next) => {
          console.log(
            color.dim(`● scout: ${next.id} is now the best free coding model; switching`),
          );
        });
        console.log(color.green(`automatic selection enabled → ${scout.pick()?.id ?? "none"}`));
      } else if (cmd === "/status") {
        console.log(`model: ${scout.pick()?.id ?? "none"}`);
        console.log(
          `selection: ${scout.isPinned ? "pinned" : `automatic (polling every ${pollMinutes}m)`}`,
        );
      } else if (cmd === "/whoami") {
        await showIdentity(client);
      } else if (cmd === "/pwd") {
        console.log(process.cwd());
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

async function chooseModel(
  scout: ModelScout,
  terminal: readline.Interface,
  selection: string,
): Promise<void> {
  await refreshWithSpinner(scout);
  if (scout.models.length === 0) {
    console.log(color.yellow("no free tool-calling models found right now"));
    return;
  }

  if (!selection) {
    printModelChoices(scout.models, scout.pick()?.id);
    selection = (
      await terminal.question(color.cyan("\nSelect a model by number (Enter to cancel): "))
    ).trim();
    if (!selection) return;
  }

  const number = Number(selection);
  const chosen = Number.isInteger(number) ? scout.models[number - 1] : undefined;
  const id = chosen?.id ?? selection;
  const model = scout.models.find((candidate) => candidate.id === id);
  if (!model) {
    console.log(color.yellow(`"${selection}" is not in the current free-model list`));
    return;
  }

  scout.pin(model.id);
  console.log(
    color.green(`switched to ${model.id}`) + color.dim(" (pinned; /auto to resume scouting)"),
  );
}

function printModelChoices(models: readonly RankedModel[], currentId?: string): void {
  const width = Math.max(...models.map((model) => model.id.length));
  models.forEach((model, index) => {
    const current = model.id === currentId ? color.green("●") : " ";
    const rank = model.codingRank === undefined ? "unranked" : `#${model.codingRank + 1} coding`;
    console.log(
      `${current} ${String(index + 1).padStart(2)}. ${model.id.padEnd(width)}  ${formatContext(model.contextLength).padStart(5)} ctx  ${color.dim(rank)}`,
    );
  });
}

main().catch((err) => {
  console.error(color.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
