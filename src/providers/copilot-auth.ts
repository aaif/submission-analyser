/**
 * GitHub Copilot authentication — the two credential paths pi-ai does not cover.
 *
 * This module exists because of a failure that cost several rounds of misdiagnosis, so the
 * reasoning is written down in full.
 *
 * pi-ai's api-key path — `envApiKeyAuth` reading `COPILOT_GITHUB_TOKEN`, which is the path a
 * headless CI job gets — sends the credential *verbatim* as the bearer to
 * `https://api.individual.githubcopilot.com`. That host refuses it:
 *
 *     400 checking third-party user token: bad request:
 *     Personal Access Tokens are not supported for this endpoint
 *
 * pi-ai's other path runs an OAuth device flow and exchanges the resulting token at
 * `/copilot_internal/v2/token` for a short-lived Copilot token — `tid=...;proxy-ep=...` —
 * which those hosts do accept. We cannot use that path: it needs an interactive browser login
 * to seed and a writable credential store to refresh, and a one-shot Actions run has neither.
 *
 * So a credential becomes usable one of two ways — the exchange, or being a class the
 * inference hosts accept verbatim:
 *
 *  1. **The Actions token.** A workflow with `copilot-requests: write` in its `permissions`
 *     block gets a `GITHUB_TOKEN` that carries Copilot entitlement, billed to the
 *     organisation that owns the repository. This is the path GitHub added on 2026-07-02
 *     precisely so that CI would stop needing a PAT, and it is what this project uses. It is
 *     **not** exchange-eligible — the exchange 404s for it, same as for a PAT — but its
 *     entitlement rides on the workflow permission rather than on an exchanged token, so it
 *     goes to the inference host directly.
 *  2. **A device-flow OAuth token** (`gho_`), from an approved Copilot client. Exchange-
 *     eligible, but it needs an interactive login to seed, so it is not a CI option.
 *
 * A fine-grained PAT with the *Copilot Requests* permission is **not** usable here, and this
 * was established the hard way. The exchange answers 404 for one — 401 when unauthenticated,
 * so the route exists and the credential authenticated; it is the exchange that does not
 * apply. Sending it directly does not work either: `npm run probe:copilot` tried all four
 * `*.githubcopilot.com` hosts against three integration ids and every one of the twelve
 * answered `Personal Access Tokens are not supported for this endpoint`. GitHub documents
 * that PAT for the Copilot **CLI binary**, which is not the same thing as the Copilot API.
 *
 * So a 404 from the exchange is a dead end, not a fallback: it means the credential cannot
 * reach a model, and saying so immediately beats a second failure one HTTP call later with a
 * less informative message. `COPILOT_BASE_URL` remains as a host override if GitHub moves the
 * endpoint, and `npm run probe:copilot` remains the empirical answer for a new credential.
 */

import { setProvider } from '@flue/runtime';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { EnvError, MODEL_CREDENTIAL } from '../env.ts';

const EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';

/**
 * Where a non-PAT credential goes when the exchange does not apply to it. GitHub documents
 * this host for third-party Copilot API access, and it carries no `individual`/`business`/
 * `enterprise` segment — consistent with it not being tied to an exchanged, entitlement-scoped
 * token.
 */
const DIRECT_BASE_URL = 'https://api.githubcopilot.com';

/**
 * Is this credential one of the kinds the inference hosts refuse outright?
 *
 * The refusal is specifically `Personal Access Tokens are not supported for this endpoint` —
 * it names the credential *class*, not the request. So the twelve refusals `probe:copilot`
 * collected for a `github_pat_` token say nothing about a `ghs_` Actions token, which is an
 * installation token and not a PAT. That distinction is the only reason a direct send is worth
 * attempting at all; without it this would be the fourth round of host-guessing.
 */
function isPersonalAccessToken(token: string): boolean {
  return token.startsWith('github_pat_') || token.startsWith('ghp_');
}

/** Where an exchanged token goes when it carries no usable `proxy-ep`. */
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
  /** The bearer token for inference. Never logged. */
  token: string;
  /** For an exchanged token, derived from its `proxy-ep`. For a PAT, the documented host. */
  baseUrl: string;
  /** Which path got us here. Printed once, so a failing run says how it authenticated. */
  strategy: 'exchanged' | 'pre-exchanged' | 'direct' | 'host-override';
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

/**
 * Thrown when the credential is fine but the *exchange* does not apply to it — a PAT. Distinct
 * from a rejection, because the response to it is to try the direct path, not to give up.
 */
export class ExchangeNotApplicable extends Error {
  constructor() {
    super('This credential is not eligible for the Copilot token exchange.');
    this.name = 'ExchangeNotApplicable';
  }
}

export async function exchangeCopilotToken(
  githubToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotSession> {
  if (looksExchanged(githubToken)) {
    return {
      token: githubToken,
      baseUrl: baseUrlFromToken(githubToken),
      strategy: 'pre-exchanged',
    };
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

  // 404 means "not for this kind of credential", not "bad credential": the route answers 401
  // when unauthenticated, so a 404 says the token authenticated and the exchange does not
  // apply to it. That is what a fine-grained PAT gets, and it is the signal to go direct.
  if (response.status === 404) throw new ExchangeNotApplicable();

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

  return { token, baseUrl: baseUrlFromToken(token), strategy: 'exchanged' };
}

/**
 * Picks a working credential path: exchange if the credential is eligible, direct if it is a
 * PAT. `COPILOT_BASE_URL` short-circuits both, for when GitHub moves a host before we notice.
 */
export async function resolveCopilotSession(
  githubToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotSession> {
  const override = process.env['COPILOT_BASE_URL']?.trim();
  if (override !== undefined && override.length > 0) {
    return { token: githubToken, baseUrl: override, strategy: 'host-override' };
  }

  try {
    return await exchangeCopilotToken(githubToken, fetchImpl);
  } catch (error) {
    if (!(error instanceof ExchangeNotApplicable)) throw error;

    // 404: the credential authenticated, but the exchange does not apply to it. What that
    // means next depends entirely on what kind of credential it is.
    if (isPersonalAccessToken(githubToken)) {
      // Measured: every `*.githubcopilot.com` host refuses a PAT under every integration id,
      // so there is nowhere to fall back to. Fail here, with the remedy, rather than one
      // opaque 400 later. See docs/models.md.
      throw new EnvError(
        `${MODEL_CREDENTIAL} is a personal access token, which no Copilot inference host ` +
          `accepts, and it is not eligible for the token exchange either (HTTP 404). Use the ` +
          `workflow's built-in GITHUB_TOKEN with \`copilot-requests: write\` in the workflow ` +
          `permissions instead. See docs/models.md.`,
      );
    }

    // Not a PAT — an Actions installation token, most likely. The exchange is documented for
    // editor OAuth clients, so a 404 here is not evidence the credential lacks entitlement;
    // the entitlement rides on the `copilot-requests: write` permission rather than on an
    // exchanged token. Send it straight to the documented third-party host. If that is refused
    // too, the message will say so, and the `Probe Copilot access` workflow reports which of
    // the four hosts (if any) does accept it — feed the winner in via COPILOT_BASE_URL.
    return { token: githubToken, baseUrl: DIRECT_BASE_URL, strategy: 'direct' };
  }
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

  const session = await resolveCopilotSession(githubToken.trim(), fetchImpl);
  process.env[MODEL_CREDENTIAL] = session.token;

  // The host and the strategy, never the credential. A failing run should say how it
  // authenticated without anyone having to guess, and this is two lines in a CI log.
  console.log(`[copilot] auth: ${session.strategy} -> ${session.baseUrl}`);

  // Each pi-ai Model object carries its own baseUrl, so overriding the provider's is not
  // enough — the models have to be remapped too, or requests keep going to the old host.
  const base = githubCopilotProvider();
  setProvider({
    ...base,
    baseUrl: session.baseUrl,
    getModels: () => base.getModels().map((model) => ({ ...model, baseUrl: session.baseUrl })),
  });
}
