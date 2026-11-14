import { homedir } from "node:os";
import { run } from "./cli";
import { prompt } from "./prompt";

process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  interactive: Boolean(process.stdin.isTTY),
  prompt,
});
