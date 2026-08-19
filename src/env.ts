/**
 * Environment access and validation.
 *
 * Design note — why this file does not use Valibot, unlike the rest of the project:
 * Valibot issues carry the offending `input` value, so a failed parse of a secret can
 * surface that secret in an error message, a log line, or a stack trace. Several of the
 * values below are credentials, and `DISCORD_WEBHOOK_URL` embeds its own bearer token in
 * the path. So secrets are validated by hand here and every thrown message names only
 * variable *names*. See docs/threat-model.md.
 *
 * Nothing in this module may log, print, or interpolate a value into a message.
 */

/** Values whose content must never appear in an error, log line, or model context. */
const SECRET_VARS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'DISCORD_WEBHOOK_URL',
  'COPILOT_GITHUB_TOKEN',
  'GEMINI_API_KEY',
] as const;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

function read(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function require_(name: string): string {
  const value = read(name);
  if (value === undefined) {
    throw new EnvError(`Missing required environment variable ${name}. See docs/secrets.md.`);
  }
  return value;
}

/** True for `1`, `true`, `yes` (case-insensitive). Anything else, including unset, is false. */
export function flag(name: string): boolean {
  const value = read(name)?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function isDryRun(): boolean {
  return flag('DRY_RUN');
}

/** Set by tests and by `npm run agent:faux`; swaps in a credential-free fake model. */
export function isFaux(): boolean {
  return flag('FLUE_FAUX');
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export function githubRepo(): RepoRef {
  const value = require_('GITHUB_REPOSITORY');
  const parts = value.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    // Safe to echo: a repository slug is public, not a credential.
    throw new EnvError(`GITHUB_REPOSITORY must be "owner/repo", got "${value}".`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/** Actions provides `GITHUB_TOKEN`; the `gh` CLI convention is `GH_TOKEN`. Accept either. */
export function githubToken(): string {
  const value = read('GITHUB_TOKEN') ?? read('GH_TOKEN');
  if (value === undefined) {
    throw new EnvError('Missing required environment variable GITHUB_TOKEN (or GH_TOKEN).');
  }
  return value;
}

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}

/**
 * Parses GOOGLE_SERVICE_ACCOUNT_JSON. Errors never include the parse output or the
 * offending text — a malformed service-account blob is still key material.
 */
export function googleServiceAccount(): ServiceAccount {
  const raw = require_('GOOGLE_SERVICE_ACCOUNT_JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnvError('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new EnvError('GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  const clientEmail = record['client_email'];
  const privateKey = record['private_key'];
  if (typeof clientEmail !== 'string' || clientEmail.length === 0) {
    throw new EnvError('GOOGLE_SERVICE_ACCOUNT_JSON is missing a "client_email" string.');
  }
  if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) {
    throw new EnvError('GOOGLE_SERVICE_ACCOUNT_JSON is missing a "private_key" string.');
  }
  return { clientEmail, privateKey };
}

export function googleDriveFolderId(): string {
  return require_('GOOGLE_DRIVE_FOLDER_ID');
}

/**
 * The webhook URL is itself a credential (its path contains the webhook token), so the
 * host is checked but never echoed back in full.
 */
export function discordWebhookUrl(): string {
  const value = require_('DISCORD_WEBHOOK_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvError('DISCORD_WEBHOOK_URL is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new EnvError('DISCORD_WEBHOOK_URL must use https.');
  }
  if (url.hostname !== 'discord.com' && url.hostname !== 'discordapp.com') {
    throw new EnvError(
      `DISCORD_WEBHOOK_URL host must be discord.com or discordapp.com, got "${url.hostname}".`,
    );
  }
  if (!url.pathname.startsWith('/api/webhooks/')) {
    throw new EnvError('DISCORD_WEBHOOK_URL path must start with /api/webhooks/.');
  }
  return value;
}

export const DEFAULT_MODEL = 'github-copilot/claude-opus-4.7';
export const FAUX_MODEL = 'faux/faux-1';

export function modelSpecifier(): string {
  if (isFaux()) return FAUX_MODEL;
  return read('FLUE_MODEL') ?? DEFAULT_MODEL;
}

/**
 * Env var each provider's credentials come from, as declared by the pi-ai built-in
 * providers that `flue run` registers. Checked up front so a missing key fails before
 * the run spends a single token, rather than as a provider error mid-analysis.
 */
const PROVIDER_CREDENTIAL: Record<string, string> = {
  'github-copilot': 'COPILOT_GITHUB_TOKEN',
  google: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export function requireModelCredential(specifier: string): void {
  const providerId = specifier.split('/')[0] ?? '';
  if (providerId === 'faux') return;
  const varName = PROVIDER_CREDENTIAL[providerId];
  if (varName === undefined) return; // Unknown provider: let Pi's own auth report it.
  if (read(varName) === undefined) {
    throw new EnvError(
      `Model "${specifier}" needs ${varName}, which is not set. See docs/secrets.md.`,
    );
  }
}

/**
 * Fail-fast preflight. Called at the top of the publish tool, before the model call, so
 * a misconfigured run costs nothing. Dry runs skip the egress credentials they won't use.
 */
export function preflight(options: { dryRun?: boolean } = {}): void {
  const dryRun = options.dryRun ?? isDryRun();
  githubRepo();
  githubToken();
  requireModelCredential(modelSpecifier());
  // Under FLUE_FAUX every egress call is replaced by an in-memory fake (src/faux.ts), so
  // demanding real Google and Discord credentials would only make the offline path
  // impossible to run.
  if (!dryRun && !isFaux()) {
    googleServiceAccount();
    googleDriveFolderId();
    discordWebhookUrl();
  }
}

/** Every secret-bearing value currently set, for the egress secret scanner. */
export function knownSecretValues(): string[] {
  const values: string[] = [];
  for (const name of SECRET_VARS) {
    const value = read(name);
    if (value !== undefined && value.length >= 8) values.push(value);
  }
  return values;
}
