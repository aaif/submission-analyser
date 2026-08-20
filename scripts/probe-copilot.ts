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

const EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';

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

async function probeExchange(token: string): Promise<Probe> {
  const label = EXCHANGE_URL;
  try {
    const response = await fetch(EXCHANGE_URL, {
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

  console.log(`\nToken exchange (what src/providers/copilot-auth.ts does today):\n`);
  print([await probeExchange(token)]);

  console.log(`\nDirect model listing, by host and integration id:\n`);
  const probes: Probe[] = [];
  for (const host of HOSTS) {
    for (const integrationId of INTEGRATION_IDS) {
      probes.push(await probeModels(host, token, integrationId));
    }
  }
  print(probes);

  const winners = probes.filter((probe) => probe.status === 200);
  console.log(
    winners.length > 0
      ? `\n${winners.length} working combination(s). The first is the one to configure.\n`
      : `\nNothing accepted this credential for inference. See docs/models.md.\n`,
  );
}

await main();
