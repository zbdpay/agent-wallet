import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const helpResult = run(["--help"]);
assert(helpResult.status === 0, `expected help to exit 0, got ${helpResult.status}`);
assert(helpResult.stdout.includes("Axo agent wallet CLI"), "expected help output to include CLI description");
assert(helpResult.stdout.includes("fetch"), "expected help output to list fetch command");
assert(helpResult.stdout.includes("onchain"), "expected help output to list onchain command");

const unknownCommandResult = run(["definitely-not-a-command"]);
assert(unknownCommandResult.status === 1, `expected unknown command to exit 1, got ${unknownCommandResult.status}`);
assert(unknownCommandResult.stdout.includes("\"error\":\"unknown_command\""), "expected JSON error envelope for unknown command");

process.stdout.write("cli smoke checks passed\n");
