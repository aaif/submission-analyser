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

function parseRepo(name: string, value: string): RepoRef {
  const parts = value.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    // Safe to echo: a repository slug is public, not a credential.
    throw new EnvError(`${name} must be "owner/repo", got "${value}".`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * The repository whose issues get analysed — which is deliberately *not* assumed to be the
 * repository the workflow runs in.
 *
 * `GITHUB_REPOSITORY` is set by Actions to the repo hosting the workflow. This agent is
 * designed to run from its own tooling repo and analyse issues filed elsewhere, so reading
 * `GITHUB_REPOSITORY` alone would fetch issue #N of the *analyst* repo: a run that succeeds,
 * publishes a Doc, and analyses entirely the wrong issue. Silent and plausible is the worst
 * failure shape available here, so the target is named explicitly by `TARGET_REPOSITORY`.
 *
 * The fallback to `GITHUB_REPOSITORY` keeps single-repo and local use working unchanged.
 */
export function targetRepo(): RepoRef {
  const explicit = read('TARGET_REPOSITORY');
  if (explicit !== undefined) return parseRepo('TARGET_REPOSITORY', explicit);
  return parseRepo('GITHUB_REPOSITORY', require_('GITHUB_REPOSITORY'));
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

/**
 * All model access goes through GitHub Copilot — one provider, one credential.
 *
 * Copilot's catalog carries 32 models from four vendors, so the fallback gets a genuinely
 * different vendor (an outage at one lab does not take out both legs) without a second API
 * key, a second billing relationship, and a second provider integration to keep working.
 *
 * Reaching any of them at all requires the token exchange in src/providers/copilot-auth.ts:
 * Copilot's inference endpoints reject a GitHub PAT as the bearer, whatever the model. That
 * is a credential-type limit, not a per-model one — a brief detour through the belief that
 * only the `anthropic-messages` models were reachable was wrong, and the Claude leg failing
 * the same way is what disproved it. See docs/models.md.
 */
export const MODEL_PROVIDER = 'github-copilot';
export const DEFAULT_MODEL = `${MODEL_PROVIDER}/claude-opus-4.7`;
export const FALLBACK_MODEL = `${MODEL_PROVIDER}/gpt-5.4`;
export const FAUX_MODEL = 'faux/faux-1';

/**
 * Rejects a specifier that is not exactly `provider/model`.
 *
 * This exists because of a real failure: `PRIMARY_MODEL` was set to
 * `github-copilot//claude-opus-5` — one extra slash — and the provider check below passed,
 * because splitting on `/` and taking element 0 still yields `github-copilot`. The run then
 * died inside the runtime with `Unknown model ID "/claude-opus-5"`, which names the symptom
 * and not the cause. A model specifier comes from a repository variable typed by hand, so
 * "someone typed it slightly wrong" is the expected input, not the exceptional one.
 */
function parseModelSpecifier(specifier: string): { providerId: string; modelId: string } {
  const parts = specifier.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    // Safe to echo: a model specifier is public configuration, not a credential.
    throw new EnvError(
      `Model specifier "${specifier}" must be exactly "provider/model". See docs/models.md.`,
    );
  }
  return { providerId: parts[0], modelId: parts[1] };
}

export function modelSpecifier(): string {
  if (isFaux()) return FAUX_MODEL;
  const specifier = read('FLUE_MODEL') ?? DEFAULT_MODEL;
  // Validated here rather than only in preflight() because the runtime resolves the model
  // when the submission starts, which is before any tool runs — so preflight is too late to
  // be the thing that catches a malformed specifier.
  parseModelSpecifier(specifier);
  return specifier;
}

/** The one credential, as declared by the pi-ai built-in provider `flue run` registers. */
export const MODEL_CREDENTIAL = 'COPILOT_GITHUB_TOKEN';

/**
 * Enforces the single-provider rule and checks the credential up front, so a
 * misconfiguration fails before the run spends a token rather than as a provider error
 * mid-analysis.
 *
 * The provider check is here, in code, and not only in docs: `FLUE_MODEL` is supplied from a
 * repository *variable*, which any maintainer can edit in one click with no review. `flue run`
 * registers every pi-ai built-in provider unconditionally, so `FLUE_MODEL=anthropic/...` plus
 * an `ANTHROPIC_API_KEY` secret would quietly work and route issue text to a provider nobody
 * agreed to send it to. Fail instead, naming the offending specifier — a model id is not a
 * credential, so it is safe to echo.
 */
export function requireModelCredential(specifier: string): void {
  const { providerId } = parseModelSpecifier(specifier);
  if (providerId === 'faux') return;
  if (providerId !== MODEL_PROVIDER) {
    throw new EnvError(
      `Model "${specifier}" uses provider "${providerId}", but all model access must go ` +
        `through "${MODEL_PROVIDER}". See docs/models.md.`,
    );
  }
  if (read(MODEL_CREDENTIAL) === undefined) {
    throw new EnvError(
      `Model "${specifier}" needs ${MODEL_CREDENTIAL}, which is not set. See docs/secrets.md.`,
    );
  }
}

/**
 * Fail-fast preflight. Called at the top of the publish tool, before the model call, so
 * a misconfigured run costs nothing. Dry runs skip the egress credentials they won't use.
 */
export function preflight(options: { dryRun?: boolean } = {}): void {
  const dryRun = options.dryRun ?? isDryRun();
  targetRepo();
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
