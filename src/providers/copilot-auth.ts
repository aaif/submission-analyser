/**
 * GitHub Copilot authentication — the token exchange pi-ai's api-key path does not do.
 *
 * This module exists because of a failure that cost two days of misdiagnosis, so the reason
 * is written down in full.
 *
 * Copilot's inference endpoints do not accept a GitHub credential as the bearer. They accept
 * a short-lived *Copilot* token, which looks like
 * `tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...`, and which you obtain by
 * presenting a GitHub token to `https://api.github.com/copilot_internal/v2/token`. Present a
 * PAT to the inference endpoint directly and it replies:
 *
 *     400 checking third-party user token: bad request:
 *     Personal Access Tokens are not supported for this endpoint
 *
 * pi-ai has two Copilot credential paths and only one of them does the exchange. Its OAuth
 * path runs a device flow, exchanges, and refreshes. Its api-key path — `envApiKeyAuth`,
 * reading `COPILOT_GITHUB_TOKEN`, which is the path a headless CI job gets — sends the value
 * *verbatim* as the bearer. So the credential arrives one step short of usable.
 *
 * We do the missing step here, in the ~40 lines it actually takes, rather than adopt the
 * OAuth path: that path needs an interactive browser login to seed and a writable credential
 * store to refresh, neither of which a one-shot GitHub Actions run has.
 *
 * Two things fall out of the exchange for free, and both were open problems before:
 *
 *  - **The host.** The exchanged token carries `proxy-ep=`, which names the account's own
 *    Copilot proxy. So an individual, business or enterprise entitlement is now handled by
 *    reading the response instead of by guessing between three hardcoded hostnames — which
 *    was documented as the project's largest residual risk.
 *  - **Failure location.** A rejected credential now fails here, at the exchange, with a
 *    message that says so, instead of surfacing as an opaque 400 from an inference endpoint
 *    on the first model call.
 */

import { setProvider } from '@flue/runtime';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { EnvError, MODEL_CREDENTIAL } from '../env.ts';

const EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_BASE_URL = 'https://api.individual.githubcopilot.com';

/**
 * The editor-impersonating headers pi-ai sends, copied deliberately rather than imported:
 * they are not exported, and the exchange rejects a request that does not carry them. If
 * Copilot tightens the endpoint, these values are the first thing to bump — and upgrading
 * pi-ai is the way to find out what to bump them to.
 */
const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

export interface CopilotSession {
  /** The bearer token for inference. Short-lived; never logged. */
  token: string;
  /** Derived from the token's `proxy-ep`, so it matches the account's entitlement. */
  baseUrl: string;
}

/**
 * True for a value that is already an exchanged Copilot token rather than a GitHub one.
 *
 * Checked so that a deployment which supplies a pre-exchanged token — or a future pi-ai that
 * does the exchange itself — is passed through untouched instead of being sent to an endpoint
 * that would reject it.
 */
function looksExchanged(token: string): boolean {
  return token.includes('tid=');
}

/** `proxy.individual.githubcopilot.com` -> `https://api.individual.githubcopilot.com`. */
function baseUrlFromToken(token: string): string {
  const match = /proxy-ep=([^;]+)/.exec(token);
  const host = match?.[1];
  if (host === undefined || host.length === 0) return DEFAULT_BASE_URL;
  // A hostname from a response is untrusted input, and it is about to become the base URL
  // every model request and every credential goes to. Accept only Copilot hosts.
  if (!/^[A-Za-z0-9.-]+\.githubcopilot\.com$/.test(host)) return DEFAULT_BASE_URL;
  return `https://${host.replace(/^proxy\./, 'api.')}`;
}

export async function exchangeCopilotToken(
  githubToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotSession> {
  if (looksExchanged(githubToken)) {
    return { token: githubToken, baseUrl: baseUrlFromToken(githubToken) };
  }

  let response: Response;
  try {
    response = await fetchImpl(EXCHANGE_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${githubToken}`,
        ...COPILOT_HEADERS,
      },
    });
  } catch (cause) {
    // Only the error's class name is carried over. A fetch failure message can echo the
    // request it failed on, and that request carries the token in a header.
    const kind = cause instanceof Error ? cause.name : 'unknown error';
    throw new EnvError(`Could not reach the Copilot token exchange at ${EXCHANGE_URL} (${kind}).`);
  }

  if (!response.ok) {
    // Status only. The body of a rejected auth request is not somewhere to look for a
    // credential, but it is also not somewhere worth trusting to be free of one.
    throw new EnvError(
      `The Copilot token exchange rejected ${MODEL_CREDENTIAL} with HTTP ${response.status}. ` +
        `The token needs the Copilot Requests permission and an active Copilot seat on the ` +
        `account that owns it. See docs/models.md.`,
    );
  }

  const body: unknown = await response.json().catch(() => undefined);
  const token = (body as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new EnvError(`The Copilot token exchange returned no token. See docs/models.md.`);
  }

  return { token, baseUrl: baseUrlFromToken(token) };
}

/**
 * Exchanges the credential and points the provider at the account's own Copilot host.
 *
 * Called for its side effects at agent-module load, because `flue run` loads only the agent
 * module — a `setProvider()` call anywhere else silently does not register.
 *
 * The exchanged token is written back to `process.env[MODEL_CREDENTIAL]` rather than threaded
 * through pi-ai's auth types, because `envApiKeyAuth` reads that variable lazily at the first
 * model call. That is the whole integration: no fork, no reimplemented auth. It is a mutation
 * of our own process environment, which the sandbox does not inherit (`env: {}`) and no tool
 * ever reads.
 */
export async function applyCopilotAuth(fetchImpl: typeof fetch = fetch): Promise<void> {
  const githubToken = process.env[MODEL_CREDENTIAL];
  if (githubToken === undefined || githubToken.trim().length === 0) {
    // Not this module's job to complain: preflight() and requireModelCredential() own the
    // "credential missing" message, and they name the variable without reading its value.
    return;
  }

  const session = await exchangeCopilotToken(githubToken.trim(), fetchImpl);
  process.env[MODEL_CREDENTIAL] = session.token;

  // Each pi-ai Model object carries its own baseUrl, so overriding the provider's is not
  // enough — the models have to be remapped too, or requests keep going to the old host.
  const base = githubCopilotProvider();
  setProvider({
    ...base,
    baseUrl: session.baseUrl,
    getModels: () => base.getModels().map((model) => ({ ...model, baseUrl: session.baseUrl })),
  });
}
