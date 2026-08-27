/**
 * Tools exposed to the model, in OpenAI function-calling format, plus their
 * local executors. File tools are confined to the working directory.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolDefinition } from "./openrouter.js";

const MAX_OUTPUT_CHARS = 30_000;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "target",
]);

export interface ToolContext {
  cwd: string;
  /** Ask the human to approve a shell command. Absent means auto-approve. */
  approveCommand?: (command: string) => Promise<boolean>;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file. Returns at most 2000 lines starting at `offset` (1-based line number, default 1).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the working directory." },
          offset: { type: "number", description: "1-based line to start from." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content. Creates parent directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the working directory." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact string in a file. `old_string` must appear exactly once (include surrounding lines to disambiguate). Read the file first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: {
            type: "string",
            description: "Exact text to find (must match exactly once).",
          },
          new_string: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories at a path (directories end with /).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path, default '.'" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents recursively with a regular expression. Returns matching lines as path:line:text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression." },
          path: { type: "string", description: "Directory or file to search, default '.'" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the working directory and return stdout+stderr. Requires user approval unless auto-approve is enabled. 120s timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run." },
        },
        required: ["command"],
      },
    },
  },
];

/** Resolve a path and refuse to escape the working directory. */
function resolveSafe(cwd: string, p: string): string {
  const resolved = path.resolve(cwd, p);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(`path escapes the working directory: ${p}`);
  }
  return resolved;
}

function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated ${text.length - limit} characters]`;
}

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return `error: tool arguments were not valid JSON: ${truncate(rawArgs, 500)}`;
  }

  try {
    switch (name) {
      case "read_file":
        return await readFile(ctx, String(args.path ?? ""), Number(args.offset ?? 1));
      case "write_file":
        return await writeFile(ctx, String(args.path ?? ""), String(args.content ?? ""));
      case "edit_file":
        return await editFile(
          ctx,
          String(args.path ?? ""),
          String(args.old_string ?? ""),
          String(args.new_string ?? ""),
        );
      case "list_dir":
        return await listDir(ctx, String(args.path ?? "."));
      case "grep":
        return await grep(ctx, String(args.pattern ?? ""), String(args.path ?? "."));
      case "bash":
        return await bash(ctx, String(args.command ?? ""));
      default:
        return `error: unknown tool "${name}"`;
    }
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function readFile(ctx: ToolContext, p: string, offset: number): Promise<string> {
  const filePath = resolveSafe(ctx.cwd, p);
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split("\n");
  const start = Math.max(1, Math.floor(offset) || 1);
  const slice = lines.slice(start - 1, start - 1 + 2000);
  const suffix =
    start - 1 + slice.length < lines.length
      ? `\n... [${lines.length} lines total; continue with offset=${start + slice.length}]`
      : "";
  return truncate(slice.join("\n")) + suffix;
}

async function writeFile(ctx: ToolContext, p: string, content: string): Promise<string> {
  const filePath = resolveSafe(ctx.cwd, p);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return `wrote ${content.length} characters to ${p}`;
}

async function editFile(
  ctx: ToolContext,
  p: string,
  oldString: string,
  newString: string,
): Promise<string> {
  const filePath = resolveSafe(ctx.cwd, p);
  const content = await fs.readFile(filePath, "utf8");
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) return `error: old_string not found in ${p}`;
  if (occurrences > 1) {
    return `error: old_string appears ${occurrences} times in ${p}; include more context to make it unique`;
  }
  await fs.writeFile(filePath, content.replace(oldString, newString), "utf8");
  return `edited ${p}`;
}

async function listDir(ctx: ToolContext, p: string): Promise<string> {
  const dirPath = resolveSafe(ctx.cwd, p);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  if (entries.length === 0) return "(empty directory)";
  return entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .join("\n");
}

async function grep(ctx: ToolContext, pattern: string, p: string): Promise<string> {
  const regex = new RegExp(pattern);
  const root = resolveSafe(ctx.cwd, p);
  const matches: string[] = [];
  const MAX_MATCHES = 200;

  async function walk(dir: string): Promise<void> {
    if (matches.length >= MAX_MATCHES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(full);
      } else if (entry.isFile()) {
        await searchFile(full);
      }
    }
  }

  async function searchFile(file: string): Promise<void> {
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat || stat.size > 1_000_000) return;
    const content = await fs.readFile(file, "utf8").catch(() => undefined);
    if (content === undefined || content.includes("\u0000")) return;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
      const line = lines[i] ?? "";
      if (regex.test(line)) {
        matches.push(`${path.relative(ctx.cwd, file)}:${i + 1}:${line.slice(0, 300)}`);
      }
    }
  }

  const stat = await fs.stat(root);
  if (stat.isFile()) await searchFile(root);
  else await walk(root);

  if (matches.length === 0) return "no matches";
  const header = matches.length >= MAX_MATCHES ? `first ${MAX_MATCHES} matches:\n` : "";
  return truncate(header + matches.join("\n"));
}

async function bash(ctx: ToolContext, command: string): Promise<string> {
  if (!command) return "error: empty command";
  if (ctx.approveCommand && !(await ctx.approveCommand(command))) {
    return "error: the user declined to run this command";
  }
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: ctx.cwd,
      timeout: 120_000,
      env: process.env,
    });
    let output = "";
    const collect = (data: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS * 2) output += data.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => resolve(`error: ${err.message}`));
    child.on("close", (code, signal) => {
      let result = truncate(output.trimEnd());
      if (signal === "SIGTERM") result += "\n[command timed out after 120s]";
      else if (code !== 0) result += `\n[exit code ${code}]`;
      resolve(result || "(no output)");
    });
  });
}
