import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvError } from '../src/env.ts';
import {
  ExchangeNotApplicable,
  applyCopilotAuth,
  exchangeCopilotToken,
  resolveCopilotSession,
} from '../src/providers/copilot-auth.ts';

/**
 * The regression these tests exist for: Copilot's inference endpoints reject a GitHub PAT,
 * and pi-ai's api-key path sends one verbatim. Every assertion here is about the exchange
 * that closes that gap — and about it never putting the credential in a message.
 */

const PAT = 'github_pat_NotARealTokenValue0000000000';
const EXCHANGED = 'tid=abc;exp=1234567890;proxy-ep=proxy.individual.githubcopilot.com;ssc=1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Records the calls so the request itself can be asserted on, not just the return value. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function thrownAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('exchangeCopilotToken', () => {
  it('exchanges a GitHub token for a Copilot token', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ token: EXCHANGED, expires_at: 1 }));
    const session = await exchangeCopilotToken(PAT, impl);

    expect(session.token).toBe(EXCHANGED);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.github.com/copilot_internal/v2/token');
  });

  // The exchange rejects a request that does not present itself as the editor plugin.
  it('sends the GitHub token as bearer, with the Copilot editor headers', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ token: EXCHANGED }));
    await exchangeCopilotToken(PAT, impl);

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${PAT}`);
    expect(headers['Copilot-Integration-Id']).toBe('vscode-chat');
    expect(headers['Editor-Version']).toContain('vscode/');
  });

  // This is what replaces guessing between api.individual / api.business / api.enterprise,
  // which was previously documented as the project's largest residual risk.
  it('derives the base URL from the token proxy-ep, so business and enterprise just work', async () => {
    for (const [proxy, expected] of [
      ['proxy.individual.githubcopilot.com', 'https://api.individual.githubcopilot.com'],
      ['proxy.business.githubcopilot.com', 'https://api.business.githubcopilot.com'],
      ['proxy.enterprise.githubcopilot.com', 'https://api.enterprise.githubcopilot.com'],
    ] as const) {
      const { impl } = stubFetch(() => jsonResponse({ token: `tid=x;proxy-ep=${proxy};` }));
      const session = await exchangeCopilotToken(PAT, impl);
      expect(session.baseUrl).toBe(expected);
    }
  });

  it('falls back to the individual host when the token carries no proxy-ep', async () => {
    const { impl } = stubFetch(() => jsonResponse({ token: 'tid=x;exp=1;' }));
    const session = await exchangeCopilotToken(PAT, impl);
    expect(session.baseUrl).toBe('https://api.individual.githubcopilot.com');
  });

  // The host arrives in a response and becomes the URL every subsequent request — and the
  // credential — is sent to. An attacker-controlled proxy-ep must not be able to redirect it.
  it('ignores a proxy-ep that is not a Copilot host', async () => {
    for (const proxy of ['evil.example.com', 'proxy.githubcopilot.com.evil.example', '']) {
      const { impl } = stubFetch(() => jsonResponse({ token: `tid=x;proxy-ep=${proxy};` }));
      const session = await exchangeCopilotToken(PAT, impl);
      expect(session.baseUrl).toBe('https://api.individual.githubcopilot.com');
    }
  });

  // A deployment might supply an already-exchanged token, or a future pi-ai might do the
  // exchange itself. Either way, re-exchanging it would send it to an endpoint that rejects it.
  it('passes an already-exchanged token straight through without a round-trip', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ token: 'should not be reached' }));
    const session = await exchangeCopilotToken(EXCHANGED, impl);

    expect(session.token).toBe(EXCHANGED);
    expect(calls).toHaveLength(0);
  });

  // 404, not 401: the route answers 401 when unauthenticated, so a 404 means the credential
  // authenticated and the exchange simply does not apply to it. That is what a fine-grained
  // PAT gets, and treating it as a rejection is what made the first attempt dead-end.
  it('reports a 404 as "not applicable" rather than as a rejection', async () => {
    const { impl } = stubFetch(() => jsonResponse({ message: 'Not Found' }, 404));
    expect(await thrownAsync(() => exchangeCopilotToken(PAT, impl))).toBeInstanceOf(
      ExchangeNotApplicable,
    );
  });

  it('fails with the HTTP status when the exchange rejects the token', async () => {
    const { impl } = stubFetch(() => jsonResponse({ message: 'Bad credentials' }, 401));
    const error = await thrownAsync(() => exchangeCopilotToken(PAT, impl));

    expect(error).toBeInstanceOf(EnvError);
    expect(String(error)).toContain('401');
    expect(String(error)).toContain('COPILOT_GITHUB_TOKEN');
  });

  it('fails when the exchange returns no usable token', async () => {
    for (const body of [{}, { token: '' }, { token: 42 }, 'not json at all']) {
      const { impl } = stubFetch(() => jsonResponse(body));
      expect(await thrownAsync(() => exchangeCopilotToken(PAT, impl))).toBeInstanceOf(EnvError);
    }
  });

  it('fails with the error class only when the exchange is unreachable', async () => {
    const impl = (() =>
      Promise.reject(new TypeError(`fetch failed for ${PAT}`))) as unknown as typeof fetch;
    const error = await thrownAsync(() => exchangeCopilotToken(PAT, impl));

    expect(error).toBeInstanceOf(EnvError);
    expect(String(error)).toContain('TypeError');
    // The rejection message interpolated the token. Ours must not carry it through.
    expect(String(error)).not.toContain(PAT);
  });

  // Every throw path, in one place: a credential must not reach a log, and the PAT is in
  // the request headers on all of them.
  it('never echoes the token in any failure message', async () => {
    const cases: Array<() => typeof fetch> = [
      () => stubFetch(() => jsonResponse({ message: PAT }, 403)).impl,
      () => stubFetch(() => jsonResponse({ token: '' })).impl,
      () => (() => Promise.reject(new Error(PAT))) as unknown as typeof fetch,
    ];
    for (const make of cases) {
      const error = await thrownAsync(() => exchangeCopilotToken(PAT, make()));
      expect(error).toBeInstanceOf(EnvError);
      expect(String((error as Error).message)).not.toContain(PAT);
    }
  });
});

describe('resolveCopilotSession', () => {
  const savedHost = process.env['COPILOT_BASE_URL'];

  afterEach(() => {
    if (savedHost === undefined) delete process.env['COPILOT_BASE_URL'];
    else process.env['COPILOT_BASE_URL'] = savedHost;
  });

  beforeEach(() => {
    delete process.env['COPILOT_BASE_URL'];
  });

  it('uses the exchanged token and its host when the credential is eligible', async () => {
    const { impl } = stubFetch(() => jsonResponse({ token: EXCHANGED }));
    const session = await resolveCopilotSession(PAT, impl);

    expect(session).toMatchObject({
      token: EXCHANGED,
      baseUrl: 'https://api.individual.githubcopilot.com',
      strategy: 'exchanged',
    });
  });

  // There is no direct-send fallback, because there is nowhere to send it: probe:copilot
  // found all four *.githubcopilot.com hosts reject a PAT under every integration id. So a
  // 404 is a dead end, and the error has to carry the actual remedy.
  it('fails with the remedy when the credential is not exchange-eligible', async () => {
    const { impl } = stubFetch(() => jsonResponse({ message: 'Not Found' }, 404));
    const error = await thrownAsync(() => resolveCopilotSession(PAT, impl));

    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).message).toContain('copilot-requests: write');
    expect((error as EnvError).message).toContain('GITHUB_TOKEN');
    expect((error as EnvError).message).not.toContain(PAT);
  });

  // A rejection is not a fallback. Retrying a 401 against another host would turn a clear
  // "your token is wrong" into a confusing second failure somewhere else.
  it('does not fall back when the exchange actually rejects the credential', async () => {
    for (const status of [401, 403, 500]) {
      const { impl } = stubFetch(() => jsonResponse({ message: 'nope' }, status));
      const error = await thrownAsync(() => resolveCopilotSession(PAT, impl));
      expect(String(error)).toContain(String(status));
    }
  });

  it('lets COPILOT_BASE_URL short-circuit both paths, for when GitHub moves a host', async () => {
    process.env['COPILOT_BASE_URL'] = 'https://api.business.githubcopilot.com';
    const { impl, calls } = stubFetch(() => jsonResponse({ token: EXCHANGED }));
    const session = await resolveCopilotSession(PAT, impl);

    expect(session).toEqual({
      token: PAT,
      baseUrl: 'https://api.business.githubcopilot.com',
      strategy: 'host-override',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('applyCopilotAuth', () => {
  const saved = process.env['COPILOT_GITHUB_TOKEN'];

  beforeEach(() => {
    delete process.env['COPILOT_GITHUB_TOKEN'];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['COPILOT_GITHUB_TOKEN'];
    else process.env['COPILOT_GITHUB_TOKEN'] = saved;
  });

  it('fails rather than leaving an unusable credential in place', async () => {
    process.env['COPILOT_GITHUB_TOKEN'] = PAT;
    const { impl } = stubFetch(() => jsonResponse({ message: 'Not Found' }, 404));

    const error = await thrownAsync(() => applyCopilotAuth(impl));

    expect(error).toBeInstanceOf(EnvError);
    // Unchanged, so nothing downstream can mistake it for a working Copilot token.
    expect(process.env['COPILOT_GITHUB_TOKEN']).toBe(PAT);
  });

  it('replaces the GitHub token in the environment with the exchanged Copilot token', async () => {
    process.env['COPILOT_GITHUB_TOKEN'] = PAT;
    const { impl } = stubFetch(() => jsonResponse({ token: EXCHANGED }));

    await applyCopilotAuth(impl);

    // pi-ai's envApiKeyAuth reads this variable lazily at the first model call, which is
    // what makes writing it back the whole integration.
    expect(process.env['COPILOT_GITHUB_TOKEN']).toBe(EXCHANGED);
  });

  // "Credential missing" is preflight()'s message to give, by variable name and without
  // reading the value. This module must not pre-empt it with a confusing network error.
  it('does nothing when the credential is unset or blank', async () => {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env['COPILOT_GITHUB_TOKEN'];
      else process.env['COPILOT_GITHUB_TOKEN'] = value;
      const { impl, calls } = stubFetch(() => jsonResponse({ token: EXCHANGED }));

      await applyCopilotAuth(impl);

      expect(calls).toHaveLength(0);
    }
  });
});
