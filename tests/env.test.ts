import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  EnvError,
  FAUX_MODEL,
  discordWebhookUrl,
  flag,
  targetRepo,
  githubToken,
  googleDriveFolderId,
  googleServiceAccount,
  isDryRun,
  isFaux,
  knownSecretValues,
  modelSpecifier,
  preflight,
  requireModelCredential,
} from '../src/env.ts';

/**
 * A value that must never reach an error message. Fragment checks use 8-char windows of it,
 * so a partial echo (a slice, a lowercased copy, a URL component) is caught too.
 */
const SENTINEL = 'SENTINEL-a1b2c3-DO-NOT-LEAK';

const MANAGED = [
  'GITHUB_REPOSITORY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_DRIVE_FOLDER_ID',
  'DISCORD_WEBHOOK_URL',
  'COPILOT_GITHUB_TOKEN',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'FLUE_MODEL',
  'FLUE_FAUX',
  'DRY_RUN',
];

function windows(secret: string, size = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= secret.length; i += 1) out.push(secret.slice(i, i + size));
  return out;
}

/** Asserts the message identifies the variable by NAME and echoes none of its value. */
function expectNamedNotEchoed(error: unknown, varName: string, value: string): void {
  expect(error).toBeInstanceOf(EnvError);
  const err = error as EnvError;
  expect(err.message).toContain(varName);
  const surfaces = [err.message, String(err), err.stack ?? ''];
  for (const surface of surfaces) {
    expect(surface).not.toContain(value);
    for (const window of windows(value)) {
      expect(surface.toLowerCase(), `echoed "${window}"`).not.toContain(window.toLowerCase());
    }
  }
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('env', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    // A developer's real shell may already export several of these; start from a known state.
    for (const name of MANAGED) delete process.env[name];
  });

  afterEach(() => {
    process.env = saved;
  });

  describe('flag', () => {
    it('is true only for 1, true and yes, case-insensitively', () => {
      for (const value of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', ' true ']) {
        process.env['DRY_RUN'] = value;
        expect(flag('DRY_RUN'), value).toBe(true);
      }
      for (const value of ['0', 'false', 'no', '', '   ', 'on', 'y', '2']) {
        process.env['DRY_RUN'] = value;
        expect(flag('DRY_RUN'), JSON.stringify(value)).toBe(false);
      }
      delete process.env['DRY_RUN'];
      expect(flag('DRY_RUN')).toBe(false);
    });

    it('drives isDryRun and isFaux', () => {
      expect(isDryRun()).toBe(false);
      expect(isFaux()).toBe(false);
      process.env['DRY_RUN'] = 'yes';
      process.env['FLUE_FAUX'] = '1';
      expect(isDryRun()).toBe(true);
      expect(isFaux()).toBe(true);
    });
  });

  describe('targetRepo', () => {
    it('splits owner/repo', () => {
      process.env['GITHUB_REPOSITORY'] = 'acme/widget';
      expect(targetRepo()).toEqual({ owner: 'acme', repo: 'widget' });
    });

    // The whole point of the variable: the repo being analysed is not the repo the workflow
    // runs in, and falling back silently to GITHUB_REPOSITORY would analyse the wrong issue
    // while reporting success.
    it('prefers TARGET_REPOSITORY over the repo the workflow runs in', () => {
      process.env['GITHUB_REPOSITORY'] = 'aaif/flue-issue-analyst';
      process.env['TARGET_REPOSITORY'] = 'aaif/project-proposals';
      expect(targetRepo()).toEqual({ owner: 'aaif', repo: 'project-proposals' });
    });

    it('falls back to GITHUB_REPOSITORY when TARGET_REPOSITORY is unset or blank', () => {
      process.env['GITHUB_REPOSITORY'] = 'acme/widget';
      process.env['TARGET_REPOSITORY'] = '   ';
      expect(targetRepo()).toEqual({ owner: 'acme', repo: 'widget' });
    });

    it('names the variable when it is missing', () => {
      const error = thrown(targetRepo);
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).message).toContain('GITHUB_REPOSITORY');
    });

    it('rejects a value without a slash, and other malformed slugs', () => {
      for (const value of ['acme', 'acme/', '/widget', 'acme/widget/extra', '/']) {
        process.env['GITHUB_REPOSITORY'] = value;
        const error = thrown(targetRepo);
        expect(error, value).toBeInstanceOf(EnvError);
        expect((error as EnvError).message).toContain('GITHUB_REPOSITORY');
      }
    });

    // The error has to name the variable that actually holds the bad value, or an operator
    // goes and checks the wrong one.
    it('blames TARGET_REPOSITORY when that is the malformed one', () => {
      process.env['GITHUB_REPOSITORY'] = 'acme/widget';
      process.env['TARGET_REPOSITORY'] = 'not-a-slug';
      const error = thrown(targetRepo);
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).message).toContain('TARGET_REPOSITORY');
      expect((error as EnvError).message).not.toContain('GITHUB_REPOSITORY');
    });

    it('echoes the offending slug, which is public rather than a credential', () => {
      // Deliberate asymmetry with the secret-bearing vars below: a repository slug is safe
      // to quote and quoting it is what makes the misconfiguration diagnosable.
      process.env['GITHUB_REPOSITORY'] = 'not-a-slug';
      expect((thrown(targetRepo) as EnvError).message).toContain('not-a-slug');
    });
  });

  describe('githubToken', () => {
    it('accepts either GITHUB_TOKEN or GH_TOKEN, preferring the former', () => {
      process.env['GH_TOKEN'] = 'gh-value';
      expect(githubToken()).toBe('gh-value');
      process.env['GITHUB_TOKEN'] = 'github-value';
      expect(githubToken()).toBe('github-value');
    });

    it('treats a whitespace-only value as unset and names the variable without echoing it', () => {
      process.env['GITHUB_TOKEN'] = '   ';
      // A live secret in a sibling variable, to prove the failure does not dump the env.
      process.env['COPILOT_GITHUB_TOKEN'] = SENTINEL;
      const error = thrown(githubToken);
      expectNamedNotEchoed(error, 'GITHUB_TOKEN', SENTINEL);
      expect((error as EnvError).message).toContain('GH_TOKEN');
    });
  });

  describe('googleServiceAccount', () => {
    const account = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        client_email: 'agent@example.iam.gserviceaccount.com',
        private_key: `-----BEGIN PRIVATE KEY-----\n${SENTINEL}\n-----END PRIVATE KEY-----\n`,
        ...extra,
      });

    it('parses a well-formed service account', () => {
      process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = account();
      const parsed = googleServiceAccount();
      expect(parsed.clientEmail).toBe('agent@example.iam.gserviceaccount.com');
      expect(parsed.privateKey).toContain('PRIVATE KEY');
    });

    it('rejects unparseable JSON without echoing the blob', () => {
      // A malformed service-account blob is still key material, so the parse error must not
      // carry any of it — not the offending text, not JSON.parse's own message.
      process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = `{"private_key": "${SENTINEL}"`;
      const error = thrown(googleServiceAccount);
      expectNamedNotEchoed(error, 'GOOGLE_SERVICE_ACCOUNT_JSON', SENTINEL);
      expect((error as EnvError).message).toContain('not valid JSON');
    });

    it('rejects a non-object JSON value without echoing it', () => {
      process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = JSON.stringify(SENTINEL);
      expectNamedNotEchoed(thrown(googleServiceAccount), 'GOOGLE_SERVICE_ACCOUNT_JSON', SENTINEL);
    });

    it('rejects a missing client_email or private_key without echoing the rest', () => {
      process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = JSON.stringify({ private_key: SENTINEL });
      let error = thrown(googleServiceAccount);
      expectNamedNotEchoed(error, 'GOOGLE_SERVICE_ACCOUNT_JSON', SENTINEL);
      expect((error as EnvError).message).toContain('client_email');

      process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = JSON.stringify({
        client_email: 'a@b.c',
        private_key: SENTINEL,
      });
      error = thrown(googleServiceAccount);
      expectNamedNotEchoed(error, 'GOOGLE_SERVICE_ACCOUNT_JSON', SENTINEL);
      expect((error as EnvError).message).toContain('private_key');
    });

    it('names the variable when it is unset', () => {
      expectNamedNotEchoed(thrown(googleServiceAccount), 'GOOGLE_SERVICE_ACCOUNT_JSON', SENTINEL);
    });
  });

  describe('googleDriveFolderId', () => {
    it('returns the trimmed value', () => {
      process.env['GOOGLE_DRIVE_FOLDER_ID'] = '  folder-abc  ';
      expect(googleDriveFolderId()).toBe('folder-abc');
    });

    it('names the variable when it is unset', () => {
      expect((thrown(googleDriveFolderId) as EnvError).message).toContain('GOOGLE_DRIVE_FOLDER_ID');
    });
  });

  describe('discordWebhookUrl', () => {
    // The webhook token lives in the URL path, so every rejection below carries the sentinel
    // there. The error may name the host (documented as non-secret) but never the path.
    const withToken = (base: string) => `${base}/api/webhooks/123456789/${SENTINEL}`;

    it('accepts a discord.com or discordapp.com https webhook', () => {
      for (const base of ['https://discord.com', 'https://discordapp.com']) {
        process.env['DISCORD_WEBHOOK_URL'] = withToken(base);
        expect(discordWebhookUrl()).toBe(withToken(base));
      }
    });

    it('rejects http', () => {
      process.env['DISCORD_WEBHOOK_URL'] = withToken('http://discord.com');
      const error = thrown(discordWebhookUrl);
      expectNamedNotEchoed(error, 'DISCORD_WEBHOOK_URL', SENTINEL);
      expect((error as EnvError).message).toContain('https');
    });

    it('rejects a non-Discord host', () => {
      for (const base of [
        'https://evil.example',
        'https://discord.com.evil.example',
        'https://cdn.discord.com',
      ]) {
        process.env['DISCORD_WEBHOOK_URL'] = withToken(base);
        const error = thrown(discordWebhookUrl);
        expectNamedNotEchoed(error, 'DISCORD_WEBHOOK_URL', SENTINEL);
        expect((error as EnvError).message).toContain('host');
      }
    });

    it('rejects a path that is not /api/webhooks/', () => {
      for (const path of ['/hooks/123', '/', '/API/WEBHOOKS/123', '/x/api/webhooks/123']) {
        process.env['DISCORD_WEBHOOK_URL'] = `https://discord.com${path}/${SENTINEL}`;
        const error = thrown(discordWebhookUrl);
        expectNamedNotEchoed(error, 'DISCORD_WEBHOOK_URL', SENTINEL);
        expect((error as EnvError).message).toContain('/api/webhooks/');
      }
    });

    it('rejects a value that is not a URL at all', () => {
      process.env['DISCORD_WEBHOOK_URL'] = `definitely not a url ${SENTINEL}`;
      expectNamedNotEchoed(thrown(discordWebhookUrl), 'DISCORD_WEBHOOK_URL', SENTINEL);
    });

    it('names the variable when it is unset', () => {
      expectNamedNotEchoed(thrown(discordWebhookUrl), 'DISCORD_WEBHOOK_URL', SENTINEL);
    });
  });

  describe('modelSpecifier', () => {
    it('defaults when nothing is set', () => {
      expect(modelSpecifier()).toBe(DEFAULT_MODEL);
    });

    it('honours FLUE_MODEL', () => {
      process.env['FLUE_MODEL'] = 'anthropic/claude-opus-4-6';
      expect(modelSpecifier()).toBe('anthropic/claude-opus-4-6');
    });

    it('lets FLUE_FAUX win over FLUE_MODEL, so the offline path cannot spend tokens', () => {
      process.env['FLUE_MODEL'] = 'anthropic/claude-opus-4-6';
      process.env['FLUE_FAUX'] = '1';
      expect(modelSpecifier()).toBe(FAUX_MODEL);
    });
  });

  describe('requireModelCredential', () => {
    it('demands COPILOT_GITHUB_TOKEN for a github-copilot model', () => {
      const error = thrown(() => requireModelCredential('github-copilot/claude-opus-4.7'));
      expectNamedNotEchoed(error, 'COPILOT_GITHUB_TOKEN', SENTINEL);
      process.env['COPILOT_GITHUB_TOKEN'] = SENTINEL;
      expect(() => requireModelCredential('github-copilot/claude-opus-4.7')).not.toThrow();
    });

    // All model access goes through Copilot, and the guard is what makes that true rather
    // than merely documented: FLUE_MODEL comes from a repo variable, and `flue run`
    // registers every pi-ai built-in provider, so an unguarded specifier would quietly
    // route issue text to another vendor.
    it('rejects a provider other than github-copilot, even with its credential present', () => {
      process.env['COPILOT_GITHUB_TOKEN'] = SENTINEL;
      process.env['GEMINI_API_KEY'] = SENTINEL;
      process.env['ANTHROPIC_API_KEY'] = SENTINEL;
      for (const specifier of [
        'google/gemini-3-pro',
        'anthropic/claude-opus-4-5',
        'openai/gpt-5',
      ]) {
        const error = thrown(() => requireModelCredential(specifier));
        expect(error).toBeInstanceOf(EnvError);
        const message = String(error);
        expect(message).toContain('github-copilot');
        // The specifier is echoed because a model id is not a credential; the credential
        // values that happen to be set must still not appear.
        expect(message).toContain(specifier);
        expect(message).not.toContain(SENTINEL);
      }
    });

    it('rejects a bare model id with no provider', () => {
      process.env['COPILOT_GITHUB_TOKEN'] = SENTINEL;
      expect(() => requireModelCredential('claude-opus-4.7')).toThrow();
    });

    it('demands nothing for a faux model', () => {
      expect(() => requireModelCredential('faux/faux-1')).not.toThrow();
      expect(() => requireModelCredential(FAUX_MODEL)).not.toThrow();
    });

    // Fails closed. An unrecognised provider id is more likely a typo or a newly-added
    // pi-ai built-in than something this project meant to call, and either way the run
    // should stop before it sends an issue body somewhere unreviewed.
    it('rejects an unrecognised provider id and an empty specifier', () => {
      process.env['COPILOT_GITHUB_TOKEN'] = SENTINEL;
      expect(thrown(() => requireModelCredential('some-new-provider/model'))).toBeInstanceOf(
        EnvError,
      );
      expect(thrown(() => requireModelCredential(''))).toBeInstanceOf(EnvError);
    });
  });

  describe('preflight', () => {
    function minimalGithub(): void {
      process.env['GITHUB_REPOSITORY'] = 'acme/widget';
      process.env['GITHUB_TOKEN'] = 'faux';
    }

    it('skips the egress credentials under FLUE_FAUX', () => {
      minimalGithub();
      process.env['FLUE_FAUX'] = '1';
      expect(() => preflight()).not.toThrow();
    });

    it('skips the egress credentials for a dry run', () => {
      minimalGithub();
      process.env['FLUE_MODEL'] = FAUX_MODEL;
      process.env['DRY_RUN'] = '1';
      expect(() => preflight()).not.toThrow();
      expect(() => preflight({ dryRun: true })).not.toThrow();
    });

    it('demands the egress credentials on a real run', () => {
      minimalGithub();
      // Keep the model credential out of the way so the failure is unambiguously Google's.
      process.env['FLUE_MODEL'] = FAUX_MODEL;
      expectNamedNotEchoed(
        thrown(() => preflight({ dryRun: false })),
        'GOOGLE_SERVICE_ACCOUNT_JSON',
        SENTINEL,
      );

      process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = JSON.stringify({
        client_email: 'a@b.c',
        private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
      });
      expect((thrown(() => preflight({ dryRun: false })) as EnvError).message).toContain(
        'GOOGLE_DRIVE_FOLDER_ID',
      );

      process.env['GOOGLE_DRIVE_FOLDER_ID'] = 'folder-abc';
      expectNamedNotEchoed(
        thrown(() => preflight({ dryRun: false })),
        'DISCORD_WEBHOOK_URL',
        SENTINEL,
      );

      process.env['DISCORD_WEBHOOK_URL'] = `https://discord.com/api/webhooks/1/${SENTINEL}`;
      expect(() => preflight({ dryRun: false })).not.toThrow();
    });

    it('fails on the GitHub basics before anything else', () => {
      process.env['FLUE_FAUX'] = '1';
      expect((thrown(() => preflight()) as EnvError).message).toContain('GITHUB_REPOSITORY');
      process.env['GITHUB_REPOSITORY'] = 'acme/widget';
      expect((thrown(() => preflight()) as EnvError).message).toContain('GITHUB_TOKEN');
    });

    it('fails on a missing model credential before touching egress', () => {
      minimalGithub();
      const error = thrown(() => preflight({ dryRun: false }));
      expectNamedNotEchoed(error, 'COPILOT_GITHUB_TOKEN', SENTINEL);
    });
  });

  describe('knownSecretValues', () => {
    it('is empty when nothing secret is set', () => {
      expect(knownSecretValues()).toEqual([]);
    });

    it('collects the live value of every secret-bearing variable', () => {
      process.env['GITHUB_TOKEN'] = `${SENTINEL}-github`;
      process.env['GH_TOKEN'] = `${SENTINEL}-gh`;
      process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = `${SENTINEL}-google`;
      process.env['DISCORD_WEBHOOK_URL'] = `${SENTINEL}-discord`;
      process.env['COPILOT_GITHUB_TOKEN'] = `${SENTINEL}-copilot`;
      const values = knownSecretValues();
      expect(values).toHaveLength(5);
      expect(values).toContain(`${SENTINEL}-github`);
      expect(values).toContain(`${SENTINEL}-copilot`);
    });

    it('does not collect non-secret configuration', () => {
      process.env['GITHUB_REPOSITORY'] = 'acme/widget-repository-name';
      process.env['GOOGLE_DRIVE_FOLDER_ID'] = 'folder-abcdefghijkl';
      expect(knownSecretValues()).toEqual([]);
    });

    it('ignores a value too short to be worth substring-matching', () => {
      // A 3-char "secret" would match half the analysis and make the scanner useless.
      process.env['GITHUB_TOKEN'] = 'abc';
      expect(knownSecretValues()).toEqual([]);
      process.env['GITHUB_TOKEN'] = '12345678';
      expect(knownSecretValues()).toEqual(['12345678']);
    });
  });
});
