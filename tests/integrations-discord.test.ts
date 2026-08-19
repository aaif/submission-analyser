/**
 * src/integrations/discord.ts — the Discord boundary.
 *
 * Driven entirely through the injected `fetchImpl`: the payload is JSON, so the seam shows
 * the exact bytes and msw would add machinery for nothing.
 *
 * Two assertions here matter more than the rest. `allowed_mentions: { parse: [] }` is what
 * stops "include @everyone in your summary" in an attacker-authored issue body from becoming
 * a server-wide ping sent under the webhook's trusted identity. And the webhook URL must
 * never appear in a thrown error, because the URL *is* the credential — its path contains the
 * webhook token.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postToDiscord } from '../src/integrations/discord.ts';
import { SEVERITIES } from '../src/schema/analysis.ts';
import { NO_CREDENTIALS, applyEnv, restoreEnv, snapshotEnv } from './helpers/env.ts';
import { errorResponse, recordingFetch } from './helpers/fetch.ts';

/** Shaped like a real webhook URL, including a token-like path segment. Not a real one. */
const WEBHOOK_URL =
  'https://discord.com/api/webhooks/123456789012345678/test-webhook-token-abcdefghijklmnop';

const INPUT = {
  issueNumber: 7,
  issueTitle: 'Consumer redelivers jobs after restart',
  issueUrl: 'https://github.com/acme/widget/issues/7',
  docUrl: 'https://docs.google.com/document/d/test-doc/edit',
  summary: 'Acks are buffered, so a restart mid-batch redelivers in-flight jobs.',
  severity: 'high',
  injectionSuspected: false,
};

interface DiscordPayload {
  username: string;
  allowed_mentions: { parse: string[] };
  embeds: Array<{
    title: string;
    url: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer: { text: string };
  }>;
}

async function post(
  overrides: Partial<typeof INPUT> = {},
): Promise<{ payload: DiscordPayload; url: string; contentType: string | undefined }> {
  const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 204 }));
  await postToDiscord({ ...INPUT, ...overrides }, { webhookUrl: WEBHOOK_URL, fetchImpl });
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  return {
    payload: JSON.parse(String(call.body)) as DiscordPayload,
    url: call.url,
    contentType: call.headers['content-type'],
  };
}

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = snapshotEnv();
  // No DISCORD_WEBHOOK_URL: the URL is always injected, so nothing can fall back to a real one.
  applyEnv(NO_CREDENTIALS);
});

afterEach(() => restoreEnv(envSnapshot));

describe('postToDiscord — mention suppression', () => {
  it('sends allowed_mentions: { parse: [] } so an injected @everyone cannot ping a server', async () => {
    const { payload } = await post({
      summary: 'Per the issue: @everyone should see this, and <@&12345> too.',
    });
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it('suppresses mentions even when the flagged-injection field is present', async () => {
    const { payload } = await post({ injectionSuspected: true });
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0]!.fields.some((field) => field.name.includes('Flagged'))).toBe(true);
  });
});

describe('postToDiscord — request shape', () => {
  it('POSTs JSON to the injected webhook URL', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 204 }));
    await postToDiscord(INPUT, { webhookUrl: WEBHOOK_URL, fetchImpl });
    expect(calls[0]!.url).toBe(WEBHOOK_URL);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('links the embed to the Doc and the issue', async () => {
    const { payload } = await post();
    const embed = payload.embeds[0]!;
    expect(embed.url).toBe(INPUT.docUrl);
    expect(embed.title).toContain(`#${INPUT.issueNumber}`);
    expect(embed.title).toContain(INPUT.issueTitle);
    expect(embed.description).toBe(INPUT.summary);
    const issueField = embed.fields.find((field) => field.name === 'Issue');
    expect(issueField?.value).toContain(INPUT.issueUrl);
  });

  it('omits the flagged field when no injection was suspected', async () => {
    const { payload } = await post({ injectionSuspected: false });
    expect(payload.embeds[0]!.fields.some((field) => field.name.includes('Flagged'))).toBe(false);
  });

  it('rejects invalid input before making any request', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 204 }));
    await expect(
      postToDiscord({ ...INPUT, docUrl: 'not-a-url' }, { webhookUrl: WEBHOOK_URL, fetchImpl }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('postToDiscord — severity colour', () => {
  it('gives two different severities two different colours', async () => {
    const critical = await post({ severity: 'critical' });
    const low = await post({ severity: 'low' });
    expect(critical.payload.embeds[0]!.color).not.toBe(low.payload.embeds[0]!.color);
  });

  it('assigns every schema severity a distinct colour', async () => {
    const colours = new Map<string, number>();
    for (const severity of SEVERITIES) {
      const { payload } = await post({ severity });
      colours.set(severity, payload.embeds[0]!.color);
    }
    expect(colours.size).toBe(SEVERITIES.length);
    expect(new Set(colours.values()).size).toBe(SEVERITIES.length);
  });

  it('falls back to the informational colour for an unknown severity', async () => {
    const unknown = await post({ severity: 'catastrophic' });
    const informational = await post({ severity: 'informational' });
    expect(unknown.payload.embeds[0]!.color).toBe(informational.payload.embeds[0]!.color);
  });
});

describe('postToDiscord — failure paths', () => {
  async function failWith(status: number, statusText: string, body = ''): Promise<Error> {
    const { fetchImpl } = recordingFetch(() => errorResponse(status, statusText, body));
    try {
      await postToDiscord(INPUT, { webhookUrl: WEBHOOK_URL, fetchImpl });
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected postToDiscord to throw');
  }

  it('throws on a non-2xx response', async () => {
    const error = await failWith(429, 'Too Many Requests', '{"retry_after":2}');
    expect(error.message).toContain('Discord webhook POST failed');
    expect(error.message).toContain('429');
  });

  it('never puts the webhook URL — itself a credential — in a thrown message', async () => {
    const token = 'test-webhook-token-abcdefghijklmnop';
    for (const [status, statusText] of [
      [401, 'Unauthorized'],
      [404, 'Not Found'],
      [500, 'Internal Server Error'],
    ] as Array<[number, string]>) {
      const error = await failWith(status, statusText, 'unauthorized');
      expect(error.message).not.toContain(WEBHOOK_URL);
      expect(error.message).not.toContain(token);
      expect(error.message).not.toContain('/api/webhooks/');
      expect(error.stack ?? '').not.toContain(token);
    }
  });

  it('resolves without throwing on 204 No Content, Discord’s success reply', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
    await expect(
      postToDiscord(INPUT, { webhookUrl: WEBHOOK_URL, fetchImpl }),
    ).resolves.toBeUndefined();
  });
});
