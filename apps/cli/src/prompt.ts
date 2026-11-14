import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/** Asks a question on the terminal. With `hidden`, the answer is not echoed (for tokens). */
export function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const muted = new Writable({ write: (_chunk, _enc, done) => done() });
  const rl = createInterface({
    input: process.stdin,
    output: opts.hidden ? muted : process.stderr,
    terminal: true,
  });
  if (opts.hidden) process.stderr.write(question);
  return new Promise((resolve) => {
    rl.question(opts.hidden ? "" : question, (answer) => {
      rl.close();
      if (opts.hidden) process.stderr.write("\n");
      resolve(answer.trim());
    });
  });
}
