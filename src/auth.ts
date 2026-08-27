import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import * as readline from "node:readline/promises";

const OPENROUTER_URL = process.env.OPENROUTER_URL ?? "https://openrouter.ai";
const API_URL = process.env.OPENROUTER_BASE_URL ?? `${OPENROUTER_URL}/api/v1`;
const VERCEL_API_URL = process.env.VERCEL_AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export type ProviderName = "openrouter" | "vercel";

interface StoredAuth {
  providers: Partial<Record<ProviderName, { apiKey: string; createdAt: string }>>;
}

export function authFilePath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME ??
    (platform() === "win32" ? process.env.APPDATA : undefined) ??
    join(homedir(), ".config");
  return join(configHome, "tether", "auth.json");
}

/** Environment credentials deliberately take precedence over saved logins. */
export async function getApiKeys(): Promise<Partial<Record<ProviderName, string>>> {
  let saved: Partial<Record<ProviderName, { apiKey: string }>> = {};
  try {
    const auth = JSON.parse(await readFile(authFilePath(), "utf8")) as Partial<StoredAuth> & {
      apiKey?: unknown;
    };
    // Migrate the original single-provider file without making users log in again.
    saved =
      auth.providers ??
      (typeof auth.apiKey === "string" ? { openrouter: { apiKey: auth.apiKey } } : {});
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`could not read saved login: ${errorMessage(error)}`, { cause: error });
    }
  }

  return {
    openrouter: process.env.OPENROUTER_API_KEY || saved.openrouter?.apiKey,
    vercel: process.env.AI_GATEWAY_API_KEY || saved.vercel?.apiKey,
  };
}

export async function chooseProvider(action: "login" | "logout"): Promise<ProviderName> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Choose a provider: \`tether ${action} openrouter\` or \`tether ${action} vercel\``,
    );
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("1. OpenRouter\n2. Vercel AI Gateway");
    const answer = (await terminal.question(`Choose a provider to ${action} [1-2]: `)).trim();
    if (answer === "1" || answer.toLowerCase() === "openrouter") return "openrouter";
    if (answer === "2" || answer.toLowerCase() === "vercel") return "vercel";
    throw new Error(`Unknown provider "${answer}"`);
  } finally {
    terminal.close();
  }
}

export async function login(provider: ProviderName, headless: boolean): Promise<void> {
  if (provider === "vercel") {
    await loginVercel();
    return;
  }

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const code = headless ? await getHeadlessCode(challenge) : await getLocalCallbackCode(challenge);
  const key = await exchangeCode(code, verifier);
  await saveApiKey("openrouter", key);
}

export async function logout(provider: ProviderName): Promise<boolean> {
  try {
    const auth = await readStoredAuth();
    if (!auth.providers[provider]) return false;
    delete auth.providers[provider];
    if (Object.keys(auth.providers).length === 0) {
      await rm(authFilePath());
    } else {
      await writeStoredAuth(auth);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function loginVercel(): Promise<void> {
  const url = "https://vercel.com/ai-gateway";
  console.log(
    "Create a Vercel AI Gateway API key, then paste it below.\n" +
      "Tether will only use Gateway model ids explicitly marked as free-tier.\n\n" +
      url,
  );
  openBrowser(url);

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const key = (await terminal.question("\nAI Gateway API key: ")).trim();
    if (!key) throw new Error("no API key entered");
    const response = await fetch(`${VERCEL_API_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      throw new Error(`Vercel rejected that API key (${response.status})`);
    }
    await saveApiKey("vercel", key);
  } finally {
    terminal.close();
  }
}

async function getHeadlessCode(challenge: string): Promise<string> {
  const url = createAuthUrl(challenge);
  console.log("Open this URL in a browser and authorize tether:\n");
  console.log(url.toString());
  console.log("\nOpenRouter will display a one-time code.");

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const code = (await terminal.question("Paste the authorization code: ")).trim();
    if (!code) throw new Error("no authorization code entered");
    return code;
  } finally {
    terminal.close();
  }
}

async function getLocalCallbackCode(challenge: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      if (error) reject(error);
      else resolve(code!);
    };

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("OpenRouter authorization failed. You can close this tab.");
        finish(new Error(error ?? "OpenRouter did not return an authorization code"));
        return;
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><title>tether connected</title>" +
          "<meta name=viewport content='width=device-width'>" +
          "<body style='font:16px system-ui;max-width:36rem;margin:15vh auto;padding:1rem'>" +
          "<h1>tether is connected</h1><p>You can close this tab and return to your terminal.</p>",
      );
      finish(undefined, code);
    });

    const timeout = setTimeout(
      () => finish(new Error("OpenRouter login timed out after 10 minutes")),
      LOGIN_TIMEOUT_MS,
    );

    server.on("error", (error) => finish(error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        finish(new Error("could not start the OAuth callback server"));
        return;
      }
      const callbackUrl = `http://localhost:${address.port}/callback`;
      const url = createAuthUrl(challenge, callbackUrl);
      console.log(`Opening OpenRouter in your browser...\n${url}`);
      if (!openBrowser(url.toString())) {
        console.log("\nCould not launch a browser. Open the URL above manually.");
      }
    });
  });
}

function createAuthUrl(challenge: string, callbackUrl?: string): URL {
  const url = new URL("/auth", OPENROUTER_URL);
  if (callbackUrl) url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key_label", "tether CLI");
  return url;
}

function openBrowser(url: string): boolean {
  const [command, args] =
    platform() === "darwin"
      ? ["open", [url]]
      : platform() === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // Missing `xdg-open`, for example, is reported asynchronously.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function exchangeCode(code: string, verifier: string): Promise<string> {
  const response = await fetch(`${API_URL}/auth/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: "S256",
    }),
  });
  const body = (await response.json().catch(() => undefined)) as
    | { key?: unknown; error?: { message?: unknown } }
    | undefined;
  if (!response.ok) {
    const detail = typeof body?.error?.message === "string" ? `: ${body.error.message}` : "";
    throw new Error(`OpenRouter key exchange failed (${response.status})${detail}`);
  }
  if (typeof body?.key !== "string" || body.key.length === 0) {
    throw new Error("OpenRouter key exchange returned no API key");
  }
  return body.key;
}

async function saveApiKey(provider: ProviderName, apiKey: string): Promise<void> {
  const auth = await readStoredAuth();
  auth.providers[provider] = { apiKey, createdAt: new Date().toISOString() };
  await writeStoredAuth(auth);
}

async function readStoredAuth(): Promise<StoredAuth> {
  try {
    const parsed = JSON.parse(await readFile(authFilePath(), "utf8")) as Partial<StoredAuth> & {
      apiKey?: unknown;
      createdAt?: unknown;
    };
    if (parsed.providers) return { providers: parsed.providers };
    if (typeof parsed.apiKey === "string") {
      return {
        providers: {
          openrouter: {
            apiKey: parsed.apiKey,
            createdAt:
              typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
          },
        },
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { providers: {} };
}

async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  const path = authFilePath();
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
