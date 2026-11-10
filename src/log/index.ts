import chalk from 'chalk';

let debugOn = false;

export function setDebug(on: boolean): void {
  debugOn = on;
}

export const log = {
  step(msg: string): void {
    console.log(chalk.blue(`- ${msg}`));
  },
  result(msg: string): void {
    console.log(chalk.yellow(`   - ${msg}`));
  },
  error(msg: string, err?: unknown): void {
    console.error(chalk.red(`   - ERROR: ${msg}`));
    if (err !== undefined) {
      const detail = err instanceof Error ? err.stack ?? err.message : String(err);
      console.error(chalk.red(`     ${detail}`));
    }
  },
  task(name: string, msg: string): void {
    console.log(chalk.green(`   - [TASK] ${name} => ${msg}`));
  },
  debug(msg: string): void {
    if (debugOn) console.log(chalk.gray(`   - [DEBUG] ${msg}`));
  },
};

/** Formats seconds as "1d 2h 3m 4s", dropping leading zero units. */
export function formatTimespan(seconds: number): string {
  let rest = Math.max(0, Math.floor(seconds));
  const d = Math.floor(rest / 86400); rest -= d * 86400;
  const h = Math.floor(rest / 3600); rest -= h * 3600;
  const m = Math.floor(rest / 60);
  const s = rest - m * 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (d > 0 || h > 0) parts.push(`${h}h`);
  if (d > 0 || h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/** Remaining-time estimate; null when no progress, nothing left, or under 30 s elapsed. */
export function eta(
  startBlock: number,
  startMs: number,
  current: number,
  target: number,
  nowMs: number,
): { seconds: number; blocksPerSecond: number } | null {
  const done = current - startBlock;
  const todo = target - current;
  const elapsed = (nowMs - startMs) / 1000;
  if (done <= 0 || todo <= 0 || elapsed <= 30) return null;
  const blocksPerSecond = done / elapsed;
  return { seconds: todo / blocksPerSecond, blocksPerSecond };
}
