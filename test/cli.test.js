import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = new URL("../dist/cli.js", import.meta.url);

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH.pathname, ...args], {
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
  try {
    await callback({ configPath, paymentsPath });
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
  assert.match(result.stdout, /withdraw/);
  assert.match(result.stdout, /fetch/);
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
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "sc_001",
            lightning_address: "agent-xyz@zbd.ai",
            status: "active",
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
        lightning_address: "agent-xyz@zbd.ai",
      });
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
        assert.equal(payload.amount, 300);
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "wr_001",
            lnurl: "lnurl1withdraw",
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
        assert.equal(payload.amount, 21);
        assert.equal(payload.invoice, "lnbc21n1challengeinvoice");

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
