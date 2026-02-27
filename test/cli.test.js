import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quoteOnchainPayout,
  createOnchainPayout,
  fetchOnchainPayout,
  retryOnchainClaim,
} from "../dist/wallet/client.js";

const CLI_PATH = new URL("../dist/cli.js", import.meta.url);

function runCliFromPath(cliPath, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      resolve({
        status: typeof code === "number" ? code : 1,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

function runCli(args, env = {}) {
  return runCliFromPath(CLI_PATH.pathname, args, env);
}

async function withTempConfigPath(callback) {
  const dir = await mkdtemp(join(tmpdir(), "zbdw-task6-"));
  const configPath = join(dir, "config.json");
  try {
    await callback({ configPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTempWalletPaths(callback) {
  const dir = await mkdtemp(join(tmpdir(), "zbdw-task7-"));
  const configPath = join(dir, "config.json");
  const paymentsPath = join(dir, "payments.json");
  const paylinksPath = join(dir, "paylinks.json");
  try {
    await callback({ configPath, paymentsPath, paylinksPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function startMockServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start mock server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

test("help output lists planned command groups", async () => {
  const result = await runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /init/);
  assert.match(result.stdout, /info/);
  assert.match(result.stdout, /balance/);
  assert.match(result.stdout, /receive/);
  assert.match(result.stdout, /send/);
  assert.match(result.stdout, /payments/);
  assert.match(result.stdout, /payment/);
  assert.match(result.stdout, /paylink/);
  assert.match(result.stdout, /withdraw/);
  assert.match(result.stdout, /onchain/);
  assert.match(result.stdout, /fetch/);
});

test("help output works when cli is invoked via symlink path", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "zbdw-symlink-"));
  const symlinkPath = join(tempDir, "zbdw");

  try {
    await symlink(CLI_PATH.pathname, symlinkPath);

    const result = await runCliFromPath(symlinkPath, ["--help"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /ZBD agent wallet CLI/);
    assert.match(result.stdout, /init/);
    assert.match(result.stdout, /fetch/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("unknown command exits 1 with structured json error", async () => {
  const result = await runCli(["not-a-command"]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");

  const body = JSON.parse(result.stdout);
  assert.equal(body.error, "unknown_command");
  assert.equal(typeof body.message, "string");
});

test("init registers identity and persists config from --key", async () => {
  await withTempConfigPath(async ({ configPath }) => {
    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/register") {
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.apiKey, "flag-key-123");

        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ lightningAddress: "agent-xyz@zbd.ai" }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["init", "--key", "flag-key-123"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");

      const body = JSON.parse(result.stdout);
      assert.deepEqual(body, {
        lightningAddress: "agent-xyz@zbd.ai",
        status: "ok",
      });

      const persisted = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(persisted.apiKey, "flag-key-123");
      assert.equal(persisted.lightningAddress, "agent-xyz@zbd.ai");
    } finally {
      await server.close();
    }
  });
});

test("info masks API key and prefers env key over config", async () => {
  await withTempConfigPath(async ({ configPath }) => {
    await writeFile(
      configPath,
      `${JSON.stringify({ apiKey: "config-key-789", lightningAddress: "agent-xyz@zbd.ai" })}\n`,
      "utf8",
    );

    const server = await startMockServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v0/wallet") {
        assert.equal(request.headers.apikey, "env-key-456");
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            message: "Successfully retrieved Wallet.",
            data: { unit: "msats", balance: "50001000" },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["info"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_API_BASE_URL: server.baseUrl,
        ZBD_API_KEY: "env-key-456",
      });

      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");

      const body = JSON.parse(result.stdout);
      assert.deepEqual(body, {
        lightningAddress: "agent-xyz@zbd.ai",
        apiKey: "***",
        balance_sats: 50001,
      });

      assert.equal(result.stdout.includes("env-key-456"), false);
      assert.equal(result.stdout.includes("config-key-789"), false);
    } finally {
      await server.close();
    }
  });
});

test("balance converts msat to sats in output", async () => {
  await withTempConfigPath(async ({ configPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v0/wallet") {
        assert.equal(request.headers.apikey, "config-key-123");
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            message: "Successfully retrieved Wallet.",
            data: { unit: "msats", balance: "12345" },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["balance"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");

      const body = JSON.parse(result.stdout);
      assert.deepEqual(body, { balance_sats: 12 });
    } finally {
      await server.close();
    }
  });
});

test("init invalid key exits 1 with JSON error", async () => {
  await withTempConfigPath(async ({ configPath }) => {
    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/register") {
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "invalid_key" }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["init", "--key", "bad-key-value"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");

      const body = JSON.parse(result.stdout);
      assert.equal(body.error, "invalid_api_key");
      assert.equal(body.message, "API key rejected by ZBD API");
      assert.equal(result.stdout.includes("bad-key-value"), false);
    } finally {
      await server.close();
    }
  });
});

test("receive <amount_sats> returns contract JSON and appends local history", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v0/charges") {
        assert.equal(request.headers.apikey, "config-key-123");
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.amount, "250000");
        assert.equal(payload.description, "Payment request");
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            success: true,
            message: "Successfully created Charge.",
            data: {
              id: "ch_001",
              invoice: {
                request: "lnbc250n1example",
              },
              expiresAt: "2026-02-25T00:00:00.000Z",
              status: "pending",
              createdAt: "2026-02-25T00:00:00.000Z",
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["receive", "250"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 0);
      const body = JSON.parse(result.stdout);
      assert.deepEqual(body, {
        invoice: "lnbc250n1example",
        payment_hash: null,
        expires_at: "2026-02-25T00:00:00.000Z",
      });

      const payments = JSON.parse(await readFile(paymentsPath, "utf8"));
      assert.equal(payments.length, 1);
      assert.equal(payments[0].id, "ch_001");
      assert.equal(payments[0].type, "receive");
      assert.equal(payments[0].amount_sats, 250);
      assert.equal(payments[0].status, "pending");
    } finally {
      await server.close();
    }
  });
});

test("receive accepts optional description argument", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v0/charges") {
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.amount, "50000");
        assert.equal(payload.description, "test");
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            success: true,
            data: {
              id: "ch_desc",
              invoice: {
                request: "lnbc50n1example",
              },
              expiresAt: "2026-02-25T00:00:00.000Z",
              status: "pending",
              createdAt: "2026-02-25T00:00:00.000Z",
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["receive", "50", "test"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 0);
      const body = JSON.parse(result.stdout);
      assert.equal(body.invoice, "lnbc50n1example");
      assert.equal(body.payment_hash, null);
      assert.equal(body.expires_at, "2026-02-25T00:00:00.000Z");
    } finally {
      await server.close();
    }
  });
});

test("receive --static returns contract JSON", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v0/static-charges") {
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.minAmount, "1000");
        assert.equal(payload.maxAmount, "500000000");
        assert.equal(payload.description, "Payment request");
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            message: "Successfully created Static Charge.",
            data: {
              id: "sc_001",
              status: "active",
              invoice: {
                request: "lnurl1staticexample",
              },
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["receive", "--static"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 0);
      const body = JSON.parse(result.stdout);
      assert.deepEqual(body, {
        charge_id: "sc_001",
        lnurl: "lnurl1staticexample",
      });

      const payments = JSON.parse(await readFile(paymentsPath, "utf8"));
      assert.equal(payments.length, 1);
      assert.equal(payments[0].amount_sats, 0);
    } finally {
      await server.close();
    }
  });
});

test("receive --static accepts amount and description", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v0/static-charges") {
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.minAmount, "50000");
        assert.equal(payload.maxAmount, "50000");
        assert.equal(payload.description, "test");
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: {
              id: "sc_002",
              status: "active",
              invoice: {
                request: "lnurl1fixedamount",
              },
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["receive", "50", "test", "--static"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        charge_id: "sc_002",
        lnurl: "lnurl1fixedamount",
      });

      const payments = JSON.parse(await readFile(paymentsPath, "utf8"));
      assert.equal(payments.length, 1);
      assert.equal(payments[0].amount_sats, 50);
    } finally {
      await server.close();
    }
  });
});

test("send auto-detects destination format and routes to expected endpoints", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const seen = [];
    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST") {
        const payload = JSON.parse(await readRequestBody(request));
        seen.push({ url: request.url, payload });
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: `pay_${seen.length}`,
            status: "completed",
            fee: 2000,
            preimage: `pre_${seen.length}`,
            createdAt: `2026-02-25T00:00:0${seen.length}.000Z`,
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const bolt = await runCli(["send", "lnbc1exampleinvoice", "10"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });
      const lnAddress = await runCli(["send", "agent@example.com", "11"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });
      const gamertag = await runCli(["send", "@agent", "12"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });
      const lnurl = await runCli(["send", "lnurl1dp68gurn8ghj7", "13"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(bolt.status, 0);
      assert.equal(lnAddress.status, 0);
      assert.equal(gamertag.status, 0);
      assert.equal(lnurl.status, 0);

      assert.deepEqual(
        seen.map((item) => item.url),
        [
          "/v0/payments",
          "/v0/ln-address/send-payment",
          "/v0/gamertag/send-payment",
          "/v0/ln-address/send-payment",
        ],
      );

      assert.equal(seen[0].payload.invoice, "lnbc1exampleinvoice");
      assert.equal(seen[0].payload.amount, undefined);
      assert.equal(seen[1].payload.lnAddress, "agent@example.com");
      assert.equal(seen[1].payload.amount, "11000");
      assert.equal(seen[1].payload.comment, "Sent via zbdw");
      assert.equal(seen[2].payload.gamertag, "agent");
      assert.equal(seen[2].payload.amount, "12000");
      assert.equal(seen[2].payload.description, "Sent via zbdw");
      assert.equal(seen[3].payload.lnAddress, "lnurl1dp68gurn8ghj7");
      assert.equal(seen[3].payload.amount, "13000");
      assert.equal(seen[3].payload.comment, "Sent via zbdw");
    } finally {
      await server.close();
    }
  });
});

test("send rejects unsupported destination with deterministic error", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const result = await runCli(["send", "invalid-destination", "10"], {
      ZBD_WALLET_CONFIG: configPath,
      ZBD_WALLET_PAYMENTS: paymentsPath,
    });

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.error, "unsupported_destination");
    assert.equal(body.message, "Unsupported destination format");
  });
});

test("payments returns local history file records", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");
    await writeFile(
      paymentsPath,
      `${JSON.stringify([
        {
          id: "pay_001",
          type: "send",
          amount_sats: 500,
          status: "completed",
          timestamp: "2026-02-25T00:00:00.000Z",
        },
      ])}\n`,
      "utf8",
    );

    const result = await runCli(["payments"], {
      ZBD_WALLET_CONFIG: configPath,
      ZBD_WALLET_PAYMENTS: paymentsPath,
    });

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(Array.isArray(body), true);
    assert.equal(body.length, 1);
    assert.equal(body[0].id, "pay_001");
  });
});

test("paylink storage supports append/read/list/find via local json file", async () => {
  await withTempWalletPaths(async ({ paylinksPath }) => {
    const storage = await import(new URL("../dist/storage/paylinks.js", import.meta.url));
    process.env.ZBD_WALLET_PAYLINKS = paylinksPath;

    try {
      assert.equal(storage.getPaylinksPath(), paylinksPath);
      assert.deepEqual(await storage.readPaylinks(), []);

      await storage.appendPaylink({
        id: "pl_001",
        status: "active",
        lifecycle: "active",
        amount_sats: 250,
        created_at: "2026-02-26T00:00:00.000Z",
      });

      const listed = await storage.listPaylinks();
      assert.equal(listed.length, 1);
      assert.deepEqual(listed[0], {
        id: "pl_001",
        status: "active",
        lifecycle: "active",
        amount_sats: 250,
        created_at: "2026-02-26T00:00:00.000Z",
      });

      assert.deepEqual(await storage.findPaylinkById("pl_001"), listed[0]);
      assert.equal(await storage.findPaylinkById("pl_missing"), null);

      const persisted = await readFile(paylinksPath, "utf8");
      assert.match(persisted, /\n$/);
    } finally {
      delete process.env.ZBD_WALLET_PAYLINKS;
    }
  });
});

test("legacy payments remain valid when paylink metadata is absent or additive", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");
    await writeFile(
      paymentsPath,
      `${JSON.stringify([
        {
          id: "legacy_001",
          type: "send",
          amount_sats: 42,
          status: "completed",
          timestamp: "2026-02-25T00:00:00.000Z",
        },
        {
          id: "paylink_001",
          type: "receive",
          amount_sats: "250",
          status: "active",
          timestamp: "2026-02-26T00:00:00.000Z",
          paylink_id: "pl_001",
          paylink_lifecycle: "active",
          paylink_amount_sats: "250",
        },
      ])}\n`,
      "utf8",
    );

    const result = await runCli(["payments"], {
      ZBD_WALLET_CONFIG: configPath,
      ZBD_WALLET_PAYMENTS: paymentsPath,
    });

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.length, 2);

    assert.equal(body[0].id, "legacy_001");
    assert.equal(Object.hasOwn(body[0], "paylink_id"), false);
    assert.equal(Object.hasOwn(body[0], "paylink_lifecycle"), false);
    assert.equal(Object.hasOwn(body[0], "paylink_amount_sats"), false);

    assert.equal(body[1].id, "paylink_001");
    assert.equal(body[1].paylink_id, "pl_001");
    assert.equal(body[1].paylink_lifecycle, "active");
    assert.equal(body[1].paylink_amount_sats, 250);
  });
});

test("paylink command create/get/list/cancel return deterministic JSON", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/paylinks") {
        assert.equal(request.headers["x-api-key"], "config-key-123");
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.amount_sats, 250);

        response.statusCode = 201;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "pl_001",
            url: "https://zbd.ai/paylinks/pl_001",
            status: "active",
            lifecycle: "active",
            amount_sats: 250,
            created_at: "2026-02-26T00:00:00.000Z",
            updated_at: "2026-02-26T00:00:00.000Z",
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/api/paylinks/pl_001") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: {
              id: "pl_001",
              url: "https://zbd.ai/paylinks/pl_001",
              status: "active",
              lifecycle: "active",
              amount_sats: 250,
              created_at: "2026-02-26T00:00:00.000Z",
              updated_at: "2026-02-26T00:10:00.000Z",
            },
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/api/paylinks") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            paylinks: [
              {
                id: "pl_001",
                url: "https://zbd.ai/paylinks/pl_001",
                status: "active",
                lifecycle: "active",
                amount_sats: 250,
                created_at: "2026-02-26T00:00:00.000Z",
                updated_at: "2026-02-26T00:10:00.000Z",
              },
              {
                id: "pl_002",
                url: "https://zbd.ai/paylinks/pl_002",
                status: "dead",
                lifecycle: "dead",
                amount_sats: 500,
                created_at: "2026-02-26T00:20:00.000Z",
                updated_at: "2026-02-26T00:25:00.000Z",
              },
            ],
          }),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/paylinks/pl_001/cancel") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            paylink: {
              id: "pl_001",
              url: "https://zbd.ai/paylinks/pl_001",
              status: "dead",
              lifecycle: "dead",
              amount_sats: 250,
              updated_at: "2026-02-26T00:30:00.000Z",
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const created = await runCli(["paylink", "create", "250"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });
      assert.equal(created.status, 0);
      assert.deepEqual(JSON.parse(created.stdout), {
        id: "pl_001",
        url: "https://zbd.ai/paylinks/pl_001",
        status: "active",
        lifecycle: "active",
        amount_sats: 250,
      });

      const fetched = await runCli(["paylink", "get", "pl_001"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });
      assert.equal(fetched.status, 0);
      assert.deepEqual(JSON.parse(fetched.stdout), {
        id: "pl_001",
        url: "https://zbd.ai/paylinks/pl_001",
        status: "active",
        lifecycle: "active",
        amount_sats: 250,
        created_at: "2026-02-26T00:00:00.000Z",
        updated_at: "2026-02-26T00:10:00.000Z",
      });

      const listed = await runCli(["paylink", "list"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });
      assert.equal(listed.status, 0);
      assert.deepEqual(JSON.parse(listed.stdout), {
        paylinks: [
          {
            id: "pl_001",
            url: "https://zbd.ai/paylinks/pl_001",
            status: "active",
            lifecycle: "active",
            amount_sats: 250,
            created_at: "2026-02-26T00:00:00.000Z",
            updated_at: "2026-02-26T00:10:00.000Z",
          },
          {
            id: "pl_002",
            url: "https://zbd.ai/paylinks/pl_002",
            status: "dead",
            lifecycle: "dead",
            amount_sats: 500,
            created_at: "2026-02-26T00:20:00.000Z",
            updated_at: "2026-02-26T00:25:00.000Z",
          },
        ],
      });

      const cancelled = await runCli(["paylink", "cancel", "pl_001"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });
      assert.equal(cancelled.status, 0);
      assert.deepEqual(JSON.parse(cancelled.stdout), {
        id: "pl_001",
        url: "https://zbd.ai/paylinks/pl_001",
        status: "dead",
        lifecycle: "dead",
      });
    } finally {
      await server.close();
    }
  });
});

test("paylink error maps API envelope to CliError deterministically", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/paylinks") {
        response.statusCode = 400;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: "invalid_paylink_amount",
            message: "Amount must be a positive integer in sats",
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["paylink", "create", "250"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 1);
      const body = JSON.parse(result.stdout);
      assert.equal(body.error, "invalid_paylink_amount");
      assert.equal(body.message, "Amount must be a positive integer in sats");
      assert.equal(body.details.status, 400);
      assert.equal(body.details.path, "/api/paylinks");
      assert.equal(body.details.response.error, "invalid_paylink_amount");
    } finally {
      await server.close();
    }
  });
});

test("paylink settlement maps pending and failed statuses deterministically", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/api/paylinks/pl_pending") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            paylink: {
              id: "pl_pending",
              url: "https://zbd.ai/paylinks/pl_pending",
              status: "active",
              lifecycle: "active",
              amount_sats: 120,
              created_at: "2026-02-26T10:00:00.000Z",
              updated_at: "2026-02-26T10:00:10.000Z",
            },
            latestAttempt: { id: "ch_pending_001" },
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/api/paylinks/pl_failed") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            paylink: {
              id: "pl_failed",
              url: "https://zbd.ai/paylinks/pl_failed",
              status: "active",
              lifecycle: "active",
              amount_sats: 121,
              created_at: "2026-02-26T10:00:20.000Z",
              updated_at: "2026-02-26T10:00:30.000Z",
            },
            latestAttempt: { id: "ch_failed_001" },
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/v0/charges/ch_pending_001") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "ch_pending_001",
            type: "receive",
            amount_sats: 120,
            status: "pending",
            createdAt: "2026-02-26T10:00:11.000Z",
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/v0/charges/ch_failed_001") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "ch_failed_001",
            type: "receive",
            amount_sats: 121,
            status: "failed",
            createdAt: "2026-02-26T10:00:31.000Z",
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const pendingResult = await runCli(["paylink", "get", "pl_pending"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
        ZBD_API_BASE_URL: server.baseUrl,
      });
      assert.equal(pendingResult.status, 0);

      const failedResult = await runCli(["paylink", "get", "pl_failed"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
        ZBD_API_BASE_URL: server.baseUrl,
      });
      assert.equal(failedResult.status, 0);

      const payments = JSON.parse(await readFile(paymentsPath, "utf8"));
      assert.equal(payments.length, 2);

      assert.deepEqual(payments[0], {
        id: "ch_pending_001",
        type: "receive",
        amount_sats: 120,
        status: "pending",
        timestamp: "2026-02-26T10:00:11.000Z",
        source: "paylink",
        paylink_id: "pl_pending",
        paylink_attempt_id: "ch_pending_001",
        paylink_lifecycle: "active",
        paylink_amount_sats: 120,
      });

      assert.deepEqual(payments[1], {
        id: "ch_failed_001",
        type: "receive",
        amount_sats: 121,
        status: "failed",
        timestamp: "2026-02-26T10:00:31.000Z",
        source: "paylink",
        paylink_id: "pl_failed",
        paylink_attempt_id: "ch_failed_001",
        paylink_lifecycle: "dead",
        paylink_amount_sats: 121,
      });
    } finally {
      await server.close();
    }
  });
});

test("paylink settlement paid projection is idempotent settlement append", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    let chargeReads = 0;
    const server = await startMockServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/api/paylinks/pl_paid") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            paylink: {
              id: "pl_paid",
              url: "https://zbd.ai/paylinks/pl_paid",
              status: "active",
              lifecycle: "active",
              amount_sats: 333,
              created_at: "2026-02-26T11:00:00.000Z",
              updated_at: "2026-02-26T11:00:10.000Z",
            },
            latestAttempt: { id: "ch_paid_001" },
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/v0/charges/ch_paid_001") {
        chargeReads += 1;
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "ch_paid_001",
            type: "receive",
            amount_sats: 333,
            status: "completed",
            preimage: "pre_paid_001",
            createdAt: "2026-02-26T11:00:11.000Z",
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const first = await runCli(["paylink", "get", "pl_paid"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
        ZBD_API_BASE_URL: server.baseUrl,
      });
      assert.equal(first.status, 0);

      const second = await runCli(["paylink", "get", "pl_paid"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
        ZBD_API_BASE_URL: server.baseUrl,
      });
      assert.equal(second.status, 0);
      assert.equal(chargeReads, 2);

      const payments = JSON.parse(await readFile(paymentsPath, "utf8"));
      assert.equal(payments.length, 1);
      assert.deepEqual(payments[0], {
        id: "ch_paid_001",
        type: "receive",
        amount_sats: 333,
        status: "completed",
        timestamp: "2026-02-26T11:00:11.000Z",
        preimage: "pre_paid_001",
        source: "paylink",
        paylink_id: "pl_paid",
        paylink_attempt_id: "ch_paid_001",
        paylink_lifecycle: "paid",
        paylink_amount_sats: 333,
      });
    } finally {
      await server.close();
    }
  });
});

test("payment lookup is local-first then API fallback with cache append", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");
    await writeFile(
      paymentsPath,
      `${JSON.stringify([
        {
          id: "local_001",
          type: "send",
          amount_sats: 123,
          status: "completed",
          timestamp: "2026-02-25T00:00:00.000Z",
          fee_sats: 1,
          preimage: "local_preimage",
        },
      ])}\n`,
      "utf8",
    );

    let chargeCalls = 0;
    const server = await startMockServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v0/charges/remote_001") {
        chargeCalls += 1;
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "remote_001",
            type: "receive",
            amount: 45000,
            fee: 1000,
            status: "completed",
            preimage: "remote_preimage",
            createdAt: "2026-02-25T00:00:02.000Z",
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/v0/charges/local_001") {
        chargeCalls += 1;
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "should_not_happen" }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const localResult = await runCli(["payment", "local_001"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });
      assert.equal(localResult.status, 0);
      const localBody = JSON.parse(localResult.stdout);
      assert.equal(localBody.id, "local_001");
      assert.equal(chargeCalls, 0);

      const remoteResult = await runCli(["payment", "remote_001"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });
      assert.equal(remoteResult.status, 0);
      const remoteBody = JSON.parse(remoteResult.stdout);
      assert.equal(remoteBody.id, "remote_001");
      assert.equal(remoteBody.type, "receive");
      assert.equal(remoteBody.amount_sats, 45);
      assert.equal(remoteBody.fee_sats, 1);
      assert.equal(chargeCalls, 1);

      const payments = JSON.parse(await readFile(paymentsPath, "utf8"));
      assert.equal(payments.length, 2);
      assert.equal(payments[1].id, "remote_001");
    } finally {
      await server.close();
    }
  });
});

test("withdraw create and status return contract-shaped JSON", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v0/withdrawal-requests") {
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.amount, "300000");
        assert.equal(payload.description, "Withdrawal request");
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "wr_001",
            invoice: {
              request: "lnurl1withdraw",
            },
            status: "pending",
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/v0/withdrawal-requests/wr_001") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "wr_001",
            status: "completed",
            amount: 300000,
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const createResult = await runCli(["withdraw", "create", "300"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(createResult.status, 0);
      assert.deepEqual(JSON.parse(createResult.stdout), {
        withdraw_id: "wr_001",
        lnurl: "lnurl1withdraw",
      });

      const statusResult = await runCli(["withdraw", "status", "wr_001"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(statusResult.status, 0);
      assert.deepEqual(JSON.parse(statusResult.stdout), {
        withdraw_id: "wr_001",
        status: "completed",
        amount_sats: 300,
      });
    } finally {
      await server.close();
    }
  });
});

test("withdraw shorthand amount maps to create", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v0/withdrawal-requests") {
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.amount, "300000");
        assert.equal(payload.description, "Withdrawal request");
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "wr_short_001",
            invoice: {
              request: "lnurl1withdrawshort",
            },
            status: "pending",
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["withdraw", "300"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        withdraw_id: "wr_short_001",
        lnurl: "lnurl1withdrawshort",
      });
    } finally {
      await server.close();
    }
  });
});

test("withdraw shorthand id maps to status", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v0/withdrawal-requests/wr_short_001") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "wr_short_001",
            status: "completed",
            amount: 50000000,
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["withdraw", "wr_short_001"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        withdraw_id: "wr_short_001",
        status: "completed",
        amount_sats: 50000,
      });
    } finally {
      await server.close();
    }
  });
});

test("withdraw create parses nested invoice uri and strips lightning prefix", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v0/withdrawal-requests") {
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.amount, "50000000");
        assert.equal(payload.description, "Withdrawal request");
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            success: true,
            data: {
              id: "wr_nested_001",
              status: "pending",
              invoice: {
                uri: "lightning:lnurl1nestedwithdraw",
              },
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["withdraw", "create", "50000"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        withdraw_id: "wr_nested_001",
        lnurl: "lnurl1nestedwithdraw",
      });
    } finally {
      await server.close();
    }
  });
});

test("withdraw without args returns instructive JSON error", async () => {
  const result = await runCli(["withdraw"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout);
  assert.equal(body.error, "invalid_withdraw_usage");
  assert.match(body.message, /withdraw <amount_sats>/);
  assert.match(body.message, /withdraw <withdraw_id>/);
});

test("fetch reuses default token cache and avoids duplicate pay", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const tempHome = await mkdtemp(join(tmpdir(), "zbdw-task8-home-"));
    const protectedUrlPath = "/paid-resource";
    const nowSeconds = Math.floor(Date.now() / 1000);
    let paymentCalls = 0;

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v0/payments") {
        paymentCalls += 1;
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.invoice, "lnbc21n1challengeinvoice");
        assert.equal(payload.amount, undefined);

        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            payment_id: "pay_fetch_001",
            preimage: "preimage_fetch_001",
            status: "completed",
            fee: 1000,
            createdAt: "2026-02-25T00:00:10.000Z",
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === protectedUrlPath) {
        const authorization = request.headers.authorization;
        if (authorization === "L402 mac_fetch_001:preimage_fetch_001") {
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ok: true, source: "paid" }));
          return;
        }

        response.statusCode = 402;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            challenge: {
              scheme: "L402",
              macaroon: "mac_fetch_001",
              invoice: "lnbc21n1challengeinvoice",
              paymentHash: "hash_fetch_001",
              amountSats: 21,
              expiresAt: nowSeconds + 120,
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const first = await runCli(["fetch", `${server.baseUrl}${protectedUrlPath}`], {
        HOME: tempHome,
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(first.status, 0);
      assert.equal(paymentCalls, 1);
      assert.deepEqual(JSON.parse(first.stdout), {
        status: 200,
        body: { ok: true, source: "paid" },
        payment_id: "pay_fetch_001",
        amount_paid_sats: 21,
      });

      const tokenCachePath = join(tempHome, ".zbd-wallet", "token-cache.json");
      const cacheContents = JSON.parse(await readFile(tokenCachePath, "utf8"));
      assert.equal(typeof cacheContents[`${server.baseUrl}${protectedUrlPath}`].authorization, "string");

      const second = await runCli(["fetch", `${server.baseUrl}${protectedUrlPath}`], {
        HOME: tempHome,
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(second.status, 0);
      assert.equal(paymentCalls, 1);
      assert.deepEqual(JSON.parse(second.stdout), {
        status: 200,
        body: { ok: true, source: "paid" },
        payment_id: null,
        amount_paid_sats: null,
      });
    } finally {
      await server.close();
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});

test("fetch exits 1 when --max-sats is below challenge amount", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    let paymentCalls = 0;
    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v0/payments") {
        paymentCalls += 1;
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ payment_id: "unexpected", preimage: "unexpected" }));
        return;
      }

      if (request.method === "GET" && request.url === "/cap-resource") {
        response.statusCode = 402;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            challenge: {
              scheme: "L402",
              macaroon: "mac_cap_001",
              invoice: "lnbc25n1challengeinvoice",
              paymentHash: "hash_cap_001",
              amountSats: 25,
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["fetch", `${server.baseUrl}/cap-resource`, "--max-sats", "10"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 1);
      assert.equal(paymentCalls, 0);
      const body = JSON.parse(result.stdout);
      assert.equal(body.error, "max_sats_exceeded");
      assert.match(body.message, /exceeds limit of 10 sats/);
    } finally {
      await server.close();
    }
  });
});

test("fetch surfaces self-pay guard from payment API", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v0/payments") {
        response.statusCode = 400;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            success: false,
            message: "You cannot Pay your own Charge.",
            errorCode: "WPAYS0011",
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/self-pay") {
        response.statusCode = 402;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            challenge: {
              scheme: "L402",
              macaroon: "mac_self_001",
              invoice: "lnbc21n1selfpayinvoice",
              paymentHash: "hash_self_001",
              amountSats: 21,
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["fetch", `${server.baseUrl}/self-pay`, "--max-sats", "21"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_API_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 1);
      const body = JSON.parse(result.stdout);
      assert.equal(body.error, "wallet_request_failed");
      assert.equal(body.details.status, 400);
      assert.equal(body.details.path, "/v0/payments");
      assert.equal(body.details.response.errorCode, "WPAYS0011");
      assert.match(body.details.response.message, /Pay your own Charge/);
    } finally {
      await server.close();
    }
  });
});

test("onchain payout client methods parse deterministic nested data envelopes", async () => {
  const server = await startMockServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/payouts/quote") {
      assert.equal(request.headers.apikey, "config-key-123");
      const payload = JSON.parse(await readRequestBody(request));
      assert.equal(payload.amount_sats, 210);
      assert.equal(payload.destination, "bc1qquotedestination");
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: {
            quote_id: "quote_001",
            amount_sats: "210",
            fee_sats: "3",
            total_sats: "213",
            destination: "bc1qquotedestination",
            expires_at: "2026-02-27T00:00:00.000Z",
          },
        }),
      );
      return;
    }

    if (request.method === "POST" && request.url === "/api/payouts") {
      assert.equal(request.headers.apikey, "config-key-123");
      const payload = JSON.parse(await readRequestBody(request));
      assert.equal(payload.amount_sats, 210);
      assert.equal(payload.destination, "bc1qquotedestination");
      assert.equal(payload.accept_terms, true);
      assert.equal(payload.payout_id, "payout_001");
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: {
            payout_id: "payout_001",
            status: "created",
            amount_sats: "210",
            destination: "bc1qquotedestination",
            request_id: "req_001",
            kickoff: {
              enqueued: true,
              workflow: "payout.create",
              kickoff_id: "kickoff_001",
            },
          },
        }),
      );
      return;
    }

    if (request.method === "GET" && request.url === "/api/payouts/payout_001") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: {
            payout_id: "payout_001",
            status: "queued",
            amount_sats: 210,
            destination: "bc1qquotedestination",
            txid: null,
            failure_code: null,
            kickoff: {
              enqueued: true,
              workflow: "payout.status.sync",
              kickoff_id: "kickoff_status_001",
            },
          },
        }),
      );
      return;
    }

    if (request.method === "POST" && request.url === "/api/payouts/payout_001/retry-claim") {
      response.statusCode = 202;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: {
            payout_id: "payout_001",
            status: "queued",
            kickoff: {
              enqueued: true,
              workflow: "payout.retry_claim",
              kickoff_id: "kickoff_retry_001",
            },
          },
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });

  const previousBaseUrl = process.env.ZBD_AI_BASE_URL;
  process.env.ZBD_AI_BASE_URL = server.baseUrl;
  try {
    const quote = await quoteOnchainPayout("config-key-123", {
      amount_sats: 210,
      destination: "bc1qquotedestination",
    });
    assert.deepEqual(quote, {
      quote_id: "quote_001",
      amount_sats: 210,
      fee_sats: 3,
      total_sats: 213,
      destination: "bc1qquotedestination",
      expires_at: "2026-02-27T00:00:00.000Z",
    });

    const created = await createOnchainPayout("config-key-123", {
      payout_id: "payout_001",
      amount_sats: 210,
      destination: "bc1qquotedestination",
      accept_terms: true,
    });
    assert.deepEqual(created, {
      payout_id: "payout_001",
      status: "created",
      amount_sats: 210,
      destination: "bc1qquotedestination",
      request_id: "req_001",
      kickoff: {
        enqueued: true,
        workflow: "payout.create",
        kickoff_id: "kickoff_001",
      },
    });

    const fetched = await fetchOnchainPayout("config-key-123", "payout_001");
    assert.deepEqual(fetched, {
      payout_id: "payout_001",
      status: "queued",
      amount_sats: 210,
      destination: "bc1qquotedestination",
      txid: null,
      failure_code: null,
      kickoff: {
        enqueued: true,
        workflow: "payout.status.sync",
        kickoff_id: "kickoff_status_001",
      },
    });

    const retried = await retryOnchainClaim("config-key-123", "payout_001");
    assert.deepEqual(retried, {
      payout_id: "payout_001",
      status: "queued",
      kickoff: {
        enqueued: true,
        workflow: "payout.retry_claim",
        kickoff_id: "kickoff_retry_001",
      },
    });
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.ZBD_AI_BASE_URL;
    } else {
      process.env.ZBD_AI_BASE_URL = previousBaseUrl;
    }
    await server.close();
  }
});

test("onchain payout client maps API validation failures to deterministic CliError details", async () => {
  const server = await startMockServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/payouts") {
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: "invalid_consent",
          message: "accept_terms must be true",
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });

  const previousBaseUrl = process.env.ZBD_AI_BASE_URL;
  process.env.ZBD_AI_BASE_URL = server.baseUrl;
  try {
    await assert.rejects(
      () =>
        createOnchainPayout("config-key-123", {
          amount_sats: 210,
          destination: "bc1qquotedestination",
          accept_terms: false,
        }),
      (error) => {
        assert.equal(error && typeof error === "object" && "code" in error ? error.code : null, "invalid_consent");
        assert.equal(
          error && typeof error === "object" && "message" in error ? error.message : null,
          "accept_terms must be true",
        );
        assert.equal(error && typeof error === "object" && "details" in error ? error.details.status : null, 400);
        assert.equal(
          error && typeof error === "object" && "details" in error ? error.details.path : null,
          "/api/payouts",
        );
        assert.equal(
          error && typeof error === "object" && "details" in error ? error.details.response.error : null,
          "invalid_consent",
        );
        return true;
      },
    );
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.ZBD_AI_BASE_URL;
    } else {
      process.env.ZBD_AI_BASE_URL = previousBaseUrl;
    }
    await server.close();
  }
});

test("onchain quote/send/status/retry-claim commands return deterministic JSON and persist onchain metadata", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/payouts/quote") {
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.amount_sats, 210);
        assert.equal(payload.destination, "bc1qquotedestination");

        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: {
              quote_id: "quote_cli_001",
              amount_sats: 210,
              fee_sats: 3,
              total_sats: 213,
              destination: "bc1qquotedestination",
              expires_at: "2026-02-27T10:00:00.000Z",
            },
          }),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/payouts") {
        const payload = JSON.parse(await readRequestBody(request));
        assert.equal(payload.amount_sats, 210);
        assert.equal(payload.destination, "bc1qquotedestination");
        assert.equal(payload.accept_terms, true);
        assert.equal(payload.payout_id, "payout_cli_001");

        response.statusCode = 201;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: {
              payout_id: "payout_cli_001",
              status: "queued",
              amount_sats: 210,
              destination: "bc1qquotedestination",
              request_id: "req_cli_001",
              kickoff: {
                enqueued: true,
                workflow: "payout.create",
                kickoff_id: "kickoff_cli_001",
              },
            },
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/api/payouts/payout_cli_001") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: {
              payout_id: "payout_cli_001",
              status: "queued",
              amount_sats: 210,
              destination: "bc1qquotedestination",
              txid: null,
              failure_code: null,
              kickoff: {
                enqueued: true,
                workflow: "payout.status.sync",
                kickoff_id: "kickoff_cli_status_001",
              },
            },
          }),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/payouts/payout_cli_001/retry-claim") {
        response.statusCode = 202;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: {
              payout_id: "payout_cli_001",
              status: "queued",
              kickoff: {
                enqueued: true,
                workflow: "payout.retry_claim",
                kickoff_id: "kickoff_cli_retry_001",
              },
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const quoted = await runCli(["onchain", "quote", "210", "bc1qquotedestination"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });
      assert.equal(quoted.status, 0);
      assert.deepEqual(JSON.parse(quoted.stdout), {
        quote_id: "quote_cli_001",
        amount_sats: 210,
        fee_sats: 3,
        total_sats: 213,
        destination: "bc1qquotedestination",
        expires_at: "2026-02-27T10:00:00.000Z",
      });

      const sent = await runCli(
        ["onchain", "send", "210", "bc1qquotedestination", "--payout-id", "payout_cli_001", "--accept-terms"],
        {
          ZBD_WALLET_CONFIG: configPath,
          ZBD_WALLET_PAYMENTS: paymentsPath,
          ZBD_AI_BASE_URL: server.baseUrl,
        },
      );
      assert.equal(sent.status, 0);
      assert.deepEqual(JSON.parse(sent.stdout), {
        payout_id: "payout_cli_001",
        status: "queued",
        amount_sats: 210,
        destination: "bc1qquotedestination",
        request_id: "req_cli_001",
        kickoff: {
          enqueued: true,
          workflow: "payout.create",
          kickoff_id: "kickoff_cli_001",
        },
      });

      const paymentHistory = JSON.parse(await readFile(paymentsPath, "utf8"));
      assert.equal(paymentHistory.length, 1);
      assert.equal(paymentHistory[0].id, "payout_cli_001");
      assert.equal(paymentHistory[0].type, "send");
      assert.equal(paymentHistory[0].amount_sats, 210);
      assert.equal(paymentHistory[0].status, "queued");
      assert.equal(paymentHistory[0].source, "onchain");
      assert.equal(paymentHistory[0].onchain_network, "bitcoin");
      assert.equal(paymentHistory[0].onchain_address, "bc1qquotedestination");
      assert.equal(paymentHistory[0].onchain_payout_id, "payout_cli_001");
      assert.equal(typeof paymentHistory[0].timestamp, "string");

      const status = await runCli(["onchain", "status", "payout_cli_001"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });
      assert.equal(status.status, 0);
      assert.deepEqual(JSON.parse(status.stdout), {
        payout_id: "payout_cli_001",
        status: "queued",
        amount_sats: 210,
        destination: "bc1qquotedestination",
        txid: null,
        failure_code: null,
        kickoff: {
          enqueued: true,
          workflow: "payout.status.sync",
          kickoff_id: "kickoff_cli_status_001",
        },
      });

      const retried = await runCli(["onchain", "retry-claim", "payout_cli_001"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });
      assert.equal(retried.status, 0);
      assert.deepEqual(JSON.parse(retried.stdout), {
        payout_id: "payout_cli_001",
        status: "queued",
        kickoff: {
          enqueued: true,
          workflow: "payout.retry_claim",
          kickoff_id: "kickoff_cli_retry_001",
        },
      });
    } finally {
      await server.close();
    }
  });
});

test("onchain status preserves terminal payout statuses deterministically", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const terminalCases = [
      { payoutId: "payout_terminal_succeeded", status: "succeeded", txid: "tx_terminal_001", failureCode: null },
      {
        payoutId: "payout_terminal_failed_invoice_expired",
        status: "failed_invoice_expired",
        txid: null,
        failureCode: "failed_invoice_expired",
      },
      {
        payoutId: "payout_terminal_failed_lockup",
        status: "failed_lockup",
        txid: null,
        failureCode: "failed_lockup",
      },
      { payoutId: "payout_terminal_refunded", status: "refunded", txid: "tx_refund_001", failureCode: null },
      { payoutId: "payout_terminal_manual_review", status: "manual_review", txid: null, failureCode: null },
    ];

    const server = await startMockServer(async (request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/api/payouts/")) {
        const payoutId = request.url.slice("/api/payouts/".length);
        const found = terminalCases.find((item) => item.payoutId === payoutId);
        if (!found) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "not_found" }));
          return;
        }

        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: {
              payout_id: found.payoutId,
              status: found.status,
              amount_sats: 210,
              destination: "bc1qterminaldestination",
              txid: found.txid,
              failure_code: found.failureCode,
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      for (const terminalCase of terminalCases) {
        const result = await runCli(["onchain", "status", terminalCase.payoutId], {
          ZBD_WALLET_CONFIG: configPath,
          ZBD_WALLET_PAYMENTS: paymentsPath,
          ZBD_AI_BASE_URL: server.baseUrl,
        });

        assert.equal(result.status, 0);
        assert.equal(result.stderr, "");

        const body = JSON.parse(result.stdout);
        assert.equal(body.payout_id, terminalCase.payoutId);
        assert.equal(body.status, terminalCase.status);
        assert.equal(body.amount_sats, 210);
        assert.equal(body.destination, "bc1qterminaldestination");
        assert.equal(body.txid, terminalCase.txid);
        assert.equal(body.failure_code, terminalCase.failureCode);
      }
    } finally {
      await server.close();
    }
  });
});

test("onchain retry-claim maps terminal API failure to deterministic CLI error", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    const server = await startMockServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/payouts/payout_terminal/retry-claim") {
        response.statusCode = 410;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: "payout_terminal",
            message: "Cannot retry claim for a terminal payout",
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const result = await runCli(["onchain", "retry-claim", "payout_terminal"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");

      const body = JSON.parse(result.stdout);
      assert.equal(body.error, "payout_terminal");
      assert.equal(body.message, "Cannot retry claim for a terminal payout");
      assert.equal(body.details.status, 410);
      assert.equal(body.details.path, "/api/payouts/payout_terminal/retry-claim");
      assert.equal(body.details.response.error, "payout_terminal");
    } finally {
      await server.close();
    }
  });
});

test("onchain send requires --accept-terms and does not call outbound API without consent", async () => {
  await withTempWalletPaths(async ({ configPath, paymentsPath }) => {
    await writeFile(configPath, `${JSON.stringify({ apiKey: "config-key-123" })}\n`, "utf8");

    let requestCount = 0;
    const server = await startMockServer(async (_request, response) => {
      requestCount += 1;
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "unexpected_request" }));
    });

    try {
      const result = await runCli(["onchain", "send", "210", "bc1qquotedestination"], {
        ZBD_WALLET_CONFIG: configPath,
        ZBD_WALLET_PAYMENTS: paymentsPath,
        ZBD_AI_BASE_URL: server.baseUrl,
      });

      assert.equal(result.status, 1);
      const body = JSON.parse(result.stdout);
      assert.equal(body.error, "accept_terms_required");
      assert.equal(body.message, "Onchain send requires --accept-terms to confirm consent");
      assert.equal(requestCount, 0);
    } finally {
      await server.close();
    }
  });
});
