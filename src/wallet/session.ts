import {
  closeLightningSession,
  openLightningSession,
  type PaymentChallengeContext,
  createZbdLightningAdapter,
} from "@axobot/mppx";
import { requestChallenge } from "@axobot/fetch";
import type { StoredMppSessionRecord } from "../storage/sessions.js";
import { CliError } from "../output/json.js";

async function readBodyText(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }
  return response.text();
}

function ensureSessionChallenge(
  challenge: ReturnType<typeof requestChallenge>,
): PaymentChallengeContext {
  if (challenge.scheme !== "MPP") {
    throw new CliError(
      "mpp_session_required",
      "Resource did not request an MPP session challenge",
    );
  }

  if (challenge.challenge.intent !== "session") {
    throw new CliError(
      "mpp_session_required",
      "Resource requested MPP charge mode instead of MPP session mode",
    );
  }

  return challenge.challenge;
}

function parseResponsePayload(bodyText: string | undefined): unknown {
  if (!bodyText) {
    return null;
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

export async function createManagedMppSession(input: {
  apiKey: string;
  url: string;
  returnInvoice?: string | undefined;
  returnLightningAddress?: string | undefined;
  zbdApiBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<{
  record: StoredMppSessionRecord;
  resourceStatus: number;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.url);
  if (response.status !== 402) {
    throw new CliError("mpp_session_not_required", "Resource did not return 402 Payment Required", {
      status: response.status,
      url: input.url,
    });
  }

  const bodyText = await readBodyText(response.clone());
  const challenge = ensureSessionChallenge(
    requestChallenge({
      status: response.status,
      headers: response.headers,
      bodyText,
    }),
  );

  const adapter = createZbdLightningAdapter({
    apiKey: input.apiKey,
    zbdApiBaseUrl: input.zbdApiBaseUrl ?? process.env.ZBD_API_BASE_URL,
    fetchImpl,
  });

  const opened = await openLightningSession({
    challenge,
    adapter,
    returnInvoice: input.returnInvoice,
    returnLightningAddress: input.returnLightningAddress,
  });

  const authorized = await fetchImpl(input.url, {
    headers: {
      authorization: `Payment ${opened.authorization}`,
    },
  });

  if (!authorized.ok) {
    const authorizedBodyText = await readBodyText(authorized.clone());
    throw new CliError("mpp_session_open_failed", "Session opened but resource retry did not succeed", {
      status: authorized.status,
      response: parseResponsePayload(authorizedBodyText),
    });
  }

  const now = new Date().toISOString();
  return {
    record: {
      sessionId: opened.sessionId,
      url: input.url,
      challenge,
      session: {
        sessionId: opened.sessionId,
        preimage: opened.preimage,
        paymentHash: opened.paymentHash,
        returnInvoice: opened.returnInvoice,
        returnLightningAddress: opened.returnLightningAddress,
        depositAmountSats: opened.depositAmountSats,
      },
      createdAt: now,
      lastUsedAt: now,
      status: "open",
    },
    resourceStatus: authorized.status,
  };
}

export async function closeManagedMppSession(input: {
  apiKey: string;
  record: StoredMppSessionRecord;
  zbdApiBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<Record<string, unknown>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const authorization = `Payment ${closeLightningSession({
    challenge: input.record.challenge,
    session: input.record.session,
  })}`;

  const response = await fetchImpl(input.record.url, {
    headers: {
      authorization,
    },
  });

  const bodyText = await readBodyText(response.clone());
  const payload = parseResponsePayload(bodyText);

  if (!response.ok) {
    throw new CliError("mpp_session_close_failed", "Failed to close MPP session", {
      status: response.status,
      response: payload,
    });
  }

  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }

  return {
    status: "closed",
  };
}
