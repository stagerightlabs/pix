/** Everything the CLI touches in the outside world, so tests can substitute it. */
export type IO = {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  fetch?: typeof fetch;
  /** True when a person is at the terminal and can be prompted. */
  interactive: boolean;
  prompt(question: string, opts?: { hidden?: boolean }): Promise<string>;
};

export const line = (io: IO, text = "") => void io.stdout.write(`${text}\n`);
/** Messages for a human, kept off stdout so piping stays clean. */
export const note = (io: IO, text: string) => void io.stderr.write(`${text}\n`);
export const printJson = (io: IO, data: unknown) => line(io, JSON.stringify(data, null, 2));

export function table(rows: string[][]): string[] {
  const widths =
    rows[0]?.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? "").length))) ?? [];
  return rows.map((r) =>
    r
      .map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const isoTime = (unix: number) => new Date(unix * 1000).toISOString().replace(".000Z", "Z");
