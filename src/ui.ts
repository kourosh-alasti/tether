/** ANSI terminal helpers — no dependencies. */

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code: number, close = 39): (s: string) => string {
  return (s) => (enabled ? `\u001b[${code}m${s}\u001b[${close}m` : s);
}

export const color = {
  dim: paint(2, 22),
  bold: paint(1, 22),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  magenta: paint(35),
  cyan: paint(36),
};

export class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private index = 0;
  private timer: NodeJS.Timeout | undefined;

  start(text: string): void {
    if (!process.stdout.isTTY) return;
    this.stop();
    this.timer = setInterval(() => {
      const frame = this.frames[this.index++ % this.frames.length];
      process.stdout.write(`\r${color.cyan(frame ?? "")} ${color.dim(text)}\u001b[K`);
    }, 80);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      process.stdout.write("\r\u001b[K");
    }
  }
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
