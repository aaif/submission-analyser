import { knownSecretValues } from '../env.ts';

/**
 * Last line of defence before egress.
 *
 * The architecture already denies the model any tool that can reach Discord, Drive or the
 * GitHub write API — see src/tools/analyze-and-publish.ts. What that does NOT close is
 * exfiltration *through content*: the analysis text is written to a Doc, summarised into
 * Discord and quoted into a public issue comment, so a value the model was somehow induced
 * to emit would travel out inside legitimate-looking prose.
 *
 * Two complementary checks, cheapest first:
 *   1. Exact substring match against the live values of every secret-bearing env var.
 *      Precise, zero false positives, and catches a credential this project actually holds.
 *   2. Shape patterns, for credentials that reached the process some other way.
 *
 * Thrown messages name only the rule that fired. Including the match would copy the
 * secret into CI logs, which is the outcome this function exists to prevent.
 */

interface Pattern {
  name: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'pem-private-key', re: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/ },
  { name: 'service-account-private-key-id', re: /"private_key_id"\s*:/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'discord-webhook-url', re: /discord(?:app)?\.com\/api\/webhooks\//i },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'bearer-header', re: /\bAuthorization\s*:\s*Bearer\s+\S{16,}/i },
];

export class SecretLeakError extends Error {
  readonly rule: string;
  readonly path: string;
  constructor(rule: string, path: string) {
    // Deliberately excludes the matched text.
    super(
      `Refusing to publish: the generated analysis matched the secret-detection rule ` +
        `"${rule}" at ${path}. Nothing was published.`,
    );
    this.name = 'SecretLeakError';
    this.rule = rule;
    this.path = path;
  }
}

/** Returns the rule name that fired, or null. Exposed for testing. */
export function findSecret(text: string): string | null {
  for (const value of knownSecretValues()) {
    if (text.includes(value)) return 'live-env-secret';
  }
  for (const pattern of PATTERNS) {
    if (pattern.re.test(text)) return pattern.name;
  }
  return null;
}

/**
 * Walks a validated analysis object (or any JSON-ish value) and throws on the first hit.
 * Keys are checked as well as values: a leaked credential used as an object key would
 * otherwise pass.
 */
export function assertNoSecrets(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    const rule = findSecret(value);
    if (rule !== null) throw new SecretLeakError(rule, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const rule = findSecret(key);
      if (rule !== null) throw new SecretLeakError(rule, `${path}.<key>`);
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}
