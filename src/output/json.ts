export interface JsonErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeErrorJson(error: JsonErrorEnvelope): void {
  writeJson(error);
}
