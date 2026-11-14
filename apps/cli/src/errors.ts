/** An error to show the user as `Error: message` and exit with `exitCode`. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: string = "error",
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
  }
}

/** Wrong flags or arguments: exit code 2. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, "usage", 2);
  }
}
