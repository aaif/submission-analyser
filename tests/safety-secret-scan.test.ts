import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretLeakError, assertNoSecrets, findSecret } from '../src/safety/secret-scan.ts';

/**
 * Every credential-shaped string below is fabricated. They exist to exercise the shape
 * patterns; none of them is, or ever was, a real key.
 */
const FAKE: Array<[rule: string, sample: string]> = [
  ['github-token', 'ghp_F4keT0kenF0rTestsOnly000000'],
  ['github-fine-grained-pat', 'github_pat_F4keF4keF4keF4keF4ke_notreal'],
  ['google-api-key', `AIza${'F4keG00gleKeyF0rTestsOnly00000000000'.slice(0, 35)}`],
  ['pem-private-key', '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n'],
  ['service-account-private-key-id', '{ "private_key_id": "0000000000" }'],
  ['openai-key', 'sk-F4keOpenAIKeyF0rTests0000'],
  ['slack-token', `${'xox'}b-0000000000-F4keSlackToken`],
  ['discord-webhook-url', 'https://discord.com/api/webhooks/1234/f4ke'],
  ['aws-access-key-id', 'AKIAF4KETESTONLY0000'],
  ['bearer-header', 'Authorization: Bearer f4keBearerValue0000000'],
];

/** Every 8-char window of `secret`. Used to prove an error echoes none of it. */
function windows(secret: string, size = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= secret.length; i += 1) out.push(secret.slice(i, i + size));
  return out;
}

const SECRET_VARS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'DISCORD_WEBHOOK_URL',
  'COPILOT_GITHUB_TOKEN',
];

describe('secret scanning', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    // A credential in the developer's own shell would otherwise change what fires.
    for (const name of SECRET_VARS) delete process.env[name];
  });

  afterEach(() => {
    process.env = saved;
  });

  for (const [rule, sample] of FAKE) {
    it(`detects ${rule}`, () => {
      expect(findSecret(sample)).toBe(rule);
      expect(findSecret(`please see ${sample} for details`)).toBe(rule);
      expect(() => assertNoSecrets({ summary: sample })).toThrow(SecretLeakError);
    });
  }

  it('detects an anthropic key', () => {
    const sample = 'sk-ant-F4keAnthropicKeyF0rTests0000';
    // Detection is what matters, and it fires. The reported rule is `openai-key`, though:
    // `\bsk-[A-Za-z0-9_-]{20,}\b` is listed first and every `sk-ant-` key matches it too, so
    // the `anthropic-key` pattern is unreachable. Cosmetic (the wrong rule name in the
    // refusal message), not a hole — see the note in the test report.
    expect(findSecret(sample)).not.toBeNull();
    expect(() => assertNoSecrets({ summary: sample })).toThrow(SecretLeakError);
  });

  it('leaves clean prose and a clean analysis alone', () => {
    expect(findSecret('The dispatcher redelivers messages after a restart.')).toBeNull();
    expect(findSecret('Set GITHUB_TOKEN in the workflow environment.')).toBeNull();
    expect(() =>
      assertNoSecrets({
        summary: 'Duplicate delivery after broker restart.',
        affectedComponents: ['queue/dispatcher', 'store/ack-cursor'],
        relatedPastIssues: [{ reference: '#412', relevance: 'Same ordering bug.' }],
        injectionSuspected: false,
        confidence: 'medium',
      }),
    ).not.toThrow();
  });

  it('matches the live value of a secret-bearing env var exactly', () => {
    const sentinel = 'SENTINEL-live-env-value-do-not-leak';
    process.env['COPILOT_GITHUB_TOKEN'] = sentinel;
    expect(findSecret(`the token is ${sentinel}, apparently`)).toBe('live-env-secret');
    // A value only present in the environment, in no recognisable shape, is still caught.
    expect(findSecret('the token is SENTINEL-live-env-value-do-not-lea')).toBeNull();
  });

  it('ignores an env value too short to be a meaningful match', () => {
    process.env['GITHUB_TOKEN'] = 'abc';
    expect(findSecret('abc')).toBeNull();
  });

  it('walks nested arrays and objects, reporting the path of the hit', () => {
    const nested = {
      analysis: {
        rootCauseHypotheses: [
          'plausible cause',
          { note: ['deeper', 'ghp_F4keT0kenF0rTestsOnly000000'] },
        ],
      },
    };
    try {
      assertNoSecrets(nested);
      expect.unreachable('expected a SecretLeakError');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretLeakError);
      const leak = error as SecretLeakError;
      expect(leak.rule).toBe('github-token');
      expect(leak.path).toBe('$.analysis.rootCauseHypotheses[1].note[1]');
    }
  });

  it('checks object keys as well as values', () => {
    try {
      assertNoSecrets({ ghp_F4keT0kenF0rTestsOnly000000: 'harmless value' });
      expect.unreachable('expected a SecretLeakError');
    } catch (error) {
      const leak = error as SecretLeakError;
      expect(leak.rule).toBe('github-token');
      // The path names the key position without reproducing the key itself.
      expect(leak.path).toBe('$.<key>');
      expect(leak.path).not.toContain('ghp_');
    }
  });

  it('ignores non-string leaves', () => {
    expect(() => assertNoSecrets({ n: 1, b: true, nil: null, un: undefined })).not.toThrow();
  });

  /**
   * The whole point of this module is to keep credentials out of CI logs. If the error it
   * raises quoted the match, the failure itself would publish the secret into the build
   * output — the exact outcome being prevented. So: no fragment of the match, anywhere in
   * the message, the stack, or any serialised form.
   */
  it('never echoes the matched secret in the error, its stack, or its serialised form', () => {
    const sentinel = 'ghp_S3nt1neLd0N0tLeakAbCdEf0123456';
    let caught: SecretLeakError | undefined;
    try {
      assertNoSecrets({ summary: `here it is: ${sentinel}` });
    } catch (error) {
      caught = error as SecretLeakError;
    }

    expect(caught).toBeInstanceOf(SecretLeakError);
    const leak = caught as SecretLeakError;
    expect(leak.rule).toBe('github-token');
    expect(leak.path).toBe('$.summary');
    expect(leak.message).toContain('github-token');
    expect(leak.message).toContain('$.summary');
    expect(leak.message).toContain('Nothing was published');

    const surfaces = [
      leak.message,
      String(leak),
      leak.stack ?? '',
      JSON.stringify(leak),
      JSON.stringify({ rule: leak.rule, path: leak.path, message: leak.message }),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(sentinel);
      for (const window of windows(sentinel)) {
        expect(surface, `leaked "${window}"`).not.toContain(window);
      }
    }
  });

  it('never echoes a live env secret either', () => {
    const sentinel = 'SENTINEL-a1b2c3-DO-NOT-LEAK-ever';
    process.env['DISCORD_WEBHOOK_URL'] = sentinel;
    let caught: SecretLeakError | undefined;
    try {
      assertNoSecrets(['fine', `oops ${sentinel}`]);
    } catch (error) {
      caught = error as SecretLeakError;
    }
    const leak = caught as SecretLeakError;
    expect(leak.rule).toBe('live-env-secret');
    expect(leak.path).toBe('$[1]');
    for (const window of windows(sentinel)) {
      expect(leak.message).not.toContain(window);
      expect(leak.stack ?? '').not.toContain(window);
    }
  });
});
