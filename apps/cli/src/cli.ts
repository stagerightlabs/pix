import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import { ApiClientError } from "./client";
import { registerInfo } from "./commands/info";
import { registerList } from "./commands/list";
import { registerLogin } from "./commands/login";
import { registerRm } from "./commands/rm";
import { registerSites } from "./commands/sites";
import { registerTag } from "./commands/tag";
import { registerTokens } from "./commands/tokens";
import { registerUpload } from "./commands/upload";
import { registerUrl } from "./commands/url";
import { makeCtx } from "./context";
import { CliError } from "./errors";
import type { IO } from "./io";

/** Exit codes: 0 success, 1 error, 2 usage error. */
export async function run(argv: string[], io: IO): Promise<0 | 1 | 2> {
  const program = new Command()
    .name("pix")
    .description("Manage images on your pix image host")
    .version(pkg.version)
    .option("--json", "print machine-readable JSON (errors go to stderr as JSON)")
    .showHelpAfterError("(add --help for usage)");

  const ctx = makeCtx(io, program);
  for (const register of [
    registerLogin,
    registerUpload,
    registerList,
    registerInfo,
    registerTag,
    registerRm,
    registerUrl,
    registerSites,
    registerTokens,
  ]) {
    register(program, ctx);
  }

  // Throw instead of exiting, and write through our IO, so the caller owns the exit code.
  const configure = (cmd: Command) => {
    cmd.exitOverride();
    cmd.configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    });
    cmd.commands.forEach(configure);
  };
  configure(program);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and version are successes; anything else is bad usage, already reported by Commander.
      return err.exitCode === 0 ? 0 : 2;
    }
    const error =
      err instanceof CliError
        ? { code: err.code, message: err.message, exit: err.exitCode }
        : {
            code: "error",
            message: err instanceof Error ? err.message : String(err),
            exit: 1 as const,
          };

    // An empty message means the details were already printed (for example per-file upload results).
    if (!error.message) return error.exit;

    if (argv.includes("--json")) {
      io.stderr.write(
        `${JSON.stringify({ error: { code: error.code, message: error.message } })}\n`,
      );
    } else {
      // The code in parentheses is the API's error code, so local errors do not show one.
      const showCode = err instanceof ApiClientError;
      io.stderr.write(`Error: ${error.message}${showCode ? ` (${error.code})` : ""}\n`);
    }
    return error.exit;
  }
}
