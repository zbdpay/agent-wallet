#!/usr/bin/env node

import { Command, CommanderError } from "commander";
import { registerCommandGroups } from "./commands/register.js";
import { CliError, writeErrorJson } from "./output/json.js";

function createProgram(): Command {
  const program = new Command();

  program
    .name("zbdw")
    .description("ZBD agent wallet CLI")
    .showHelpAfterError(false)
    .allowExcessArguments(false)
    .configureOutput({
      writeErr: () => undefined,
      outputError: () => undefined,
    });

  registerCommandGroups(program);
  program.exitOverride();
  return program;
}

function toErrorEnvelope(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof CommanderError) {
    if (error.code === "commander.unknownCommand") {
      return {
        code: "unknown_command",
        message: error.message,
      };
    }

    return {
      code: "cli_error",
      message: error.message,
      details: {
        commander_code: error.code,
      },
    };
  }

  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: error.message,
    };
  }

  return {
    code: "internal_error",
    message: "Unknown CLI error",
  };
}

export async function run(argv = process.argv): Promise<number> {
  const program = createProgram();

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return 0;
    }

    const envelope = toErrorEnvelope(error);
    writeErrorJson({
      error: envelope.code,
      message: envelope.message,
      details: envelope.details,
    });
    return 1;
  }
}

const isMainModule =
  typeof process.argv[1] === "string" && import.meta.url === new URL(process.argv[1], "file://").href;

if (isMainModule) {
  run().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
