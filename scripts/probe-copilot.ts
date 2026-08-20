/**
 * Manual probe: which Copilot host and integration id accept this credential?
 *
 *   npm run probe:copilot
 *
 * Exists because the question turned out to be genuinely undocumented, and because guessing
 * at it burned two rounds of canary runs. GitHub documents a fine-grained PAT with the
 * *Copilot Requests* permission as a supported way to authenticate Copilot CLI in
 * non-interactive environments, so the credential is legitimate — but the host pi-ai points
 * at rejects it (`Personal Access Tokens are not supported for this endpoint`), and the token
 * exchange that would convert it returns 404. Something in the middle works; this finds it.
 *
 * Every request is a read-only `GET /models`. Nothing is created, nothing is charged, and no
 * model is invoked.
 *
 * Deliberately NOT part of `npm test`: it needs a real credential and reaches the network.
 */

import { MODEL_CREDENTIAL } from '../src/env.ts';

/**
 * `api.githubcopilot.com` is the host GitHub documents for third-party Copilot API access.
 * The `individual`/`business`/`enterprise` hosts are the per-entitlement proxies pi-ai's
 * catalog points at, and are what an exchanged editor token is scoped to.
 */
const HOSTS = [
  'https://api.githubcopilot.com',
  'https://api.individual.githubcopilot.com',
  'https://api.business.githubcopilot.com',
  'https://api.enterprise.githubcopilot.com',
];

/**
 * Copilot gates on the integration id, and pi-ai claims to be VS Code Copilot Chat. If the
 * endpoint expects an editor OAuth token from a `vscode-chat` integration, a PAT presented
 * under that id is exactly the request it should refuse — so the id is part of the matrix,
 * not a constant.
 */
const INTEGRATION_IDS = ['vscode-chat', 'copilot-cli', undefined];

/**
 * `/copilot_internal/v2/token` is the route pi-ai's OAuth path uses and the one this project
 * calls. It 404s for both an Actions token and a PAT, which means the exchange for those
 * credential classes — if it exists — lives elsewhere. The rest of this list is the search:
 * every one is a read-only GET, and a 404 rules a candidate out as cheaply as it gets.
 */
const EXCHANGE_URLS = [
  'https://api.github.com/copilot_internal/v2/token',
  'https://api.github.com/copilot_internal/v3/token',
  'https://api.github.com/copilot_internal/token',
  'https://api.github.com/copilot_internal/user',
  'https://api.githubcopilot.com/copilot_internal/v2/token',
  'https://copilot-proxy.githubusercontent.com/v1/models',
  // The CLI contacts github.com alongside the inference host, and `github-copilot/chat/token`
  // is a known token route there. If the exchange for a server-to-server token lives anywhere,
  // this is the likeliest neighbourhood.
  'https://github.com/github-copilot/chat/token',
  'https://github.com/github-copilot/token',
  'https://github.com/copilot_internal/v2/token',
];

const EXCHANGE_URL = EXCHANGE_URLS[0] as string;

interface Probe {
  label: string;
  status: number | string;
  note: string;
}

/**
 * Redacts the credential from anything about to be printed.
 *
 * The bodies here are auth-error bodies from a service that was just handed a token, and this
 * output is the kind of thing that gets pasted into an issue.
 */
function redact(text: string, secret: string): string {
  return secret.length > 0 ? text.split(secret).join('[REDACTED]') : text;
}

function summarise(body: string, secret: string): string {
  const collapsed = redact(body, secret).replace(/\s+/g, ' ').trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed;
}

async function probeModels(host: string, token: string, integrationId?: string): Promise<Probe> {
  const label = `${host}  [${integrationId ?? 'no integration id'}]`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'GitHubCopilotChat/0.35.0',
    'Editor-Version': 'vscode/1.107.0',
    'Editor-Plugin-Version': 'copilot-chat/0.35.0',
    'X-GitHub-Api-Version': '2026-06-01',
  };
  if (integrationId !== undefined) headers['Copilot-Integration-Id'] = integrationId;

  try {
    const response = await fetch(`${host}/models`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    if (response.ok) {
      // A 200 is the answer. Count the models so it is obvious the response is real.
      let count = 'unknown';
      try {
        const parsed: unknown = JSON.parse(body);
        const data = (parsed as { data?: unknown }).data;
        if (Array.isArray(data)) count = String(data.length);
      } catch {
        /* body shape is not the point of this probe */
      }
      return { label, status: response.status, note: `WORKS — ${count} models listed` };
    }
    return { label, status: response.status, note: summarise(body, token) };
  } catch (error) {
    return {
      label,
      status: 'network',
      note: error instanceof Error ? error.name : 'unknown error',
    };
  }
}

async function probeExchange(token: string, url: string = EXCHANGE_URL): Promise<Probe> {
  const label = url;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'GitHubCopilotChat/0.35.0',
        'Editor-Version': 'vscode/1.107.0',
        'Editor-Plugin-Version': 'copilot-chat/0.35.0',
        'Copilot-Integration-Id': 'vscode-chat',
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    if (!response.ok) return { label, status: response.status, note: summarise(body, token) };
    // Report the proxy host, not the token: that field is the whole reason to call this.
    const proxy = /proxy-ep=([^;"]+)/.exec(body)?.[1] ?? 'no proxy-ep in token';
    return { label, status: response.status, note: `WORKS — proxy-ep=${proxy}` };
  } catch (error) {
    return { label, status: 'network', note: error instanceof Error ? error.name : 'unknown' };
  }
}

function print(rows: Probe[]): void {
  const width = Math.max(...rows.map((row) => row.label.length));
  for (const row of rows) {
    console.log(`${row.label.padEnd(width)}  ${String(row.status).padStart(7)}  ${row.note}`);
  }
}

async function main(): Promise<void> {
  const token = process.env[MODEL_CREDENTIAL]?.trim();
  if (token === undefined || token.length === 0) {
    throw new Error(`${MODEL_CREDENTIAL} is not set.`);
  }

  // The prefix before the first underscore, and nothing else. Which *kind* of credential
  // this is decides the whole result — ghs_ (an Actions token) is exchange-eligible,
  // github_pat_ is not — and every past round of confusion here came from not knowing which
  // one was actually in the environment.
  const kind = /^([A-Za-z]+_)/.exec(token)?.[1] ?? '(no recognised prefix)';
  console.log(
    `\nCredential kind: ${kind}  (ghs_ = Actions token, gho_ = OAuth, github_pat_ = PAT)`,
  );

  console.log(`\nToken exchange candidates (the first is what the code calls today):\n`);
  const exchanges: Probe[] = [];
  for (const url of EXCHANGE_URLS) {
    exchanges.push(await probeExchange(token, url));
  }
  print(exchanges);

  console.log(`\nDirect model listing, by host and integration id:\n`);
  const probes: Probe[] = [];
  for (const host of HOSTS) {
    for (const integrationId of INTEGRATION_IDS) {
      probes.push(await probeModels(host, token, integrationId));
    }
  }
  print(probes);

  const exchangeWinners = exchanges.filter((probe) => probe.status === 200);
  if (exchangeWinners.length > 0) {
    console.log(
      `\n${exchangeWinners.length} exchange route(s) answered 200. That is the route to call.\n`,
    );
  }

  const winners = probes.filter((probe) => probe.status === 200);
  console.log(
    winners.length > 0
      ? `\n${winners.length} working combination(s). The first is the one to configure.\n`
      : `\nNothing accepted this credential for inference. See docs/models.md.\n`,
  );
}

await main();
