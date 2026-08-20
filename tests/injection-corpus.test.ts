import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fence } from '../src/safety/fence.ts';
import { sanitize } from '../src/safety/sanitize.ts';
import { SecretLeakError, assertNoSecrets, findSecret } from '../src/safety/secret-scan.ts';
import { docTitle, renderAnalysisMarkdown, renderDiscordSummary } from '../src/render.ts';
import type { Analysis } from '../src/schema/analysis.ts';
import type { Issue } from '../src/integrations/github.ts';

/**
 * The hostile-corpus regression suite. Every fixture in tests/fixtures/injections is a
 * plausible issue body written to attack this agent, and every fixture is driven through the
 * whole model-free path: fence (ingress) -> sanitize + render (egress). No model, no network,
 * so a failure here is always a real regression in the deterministic defences.
 */

const DIR = join(import.meta.dirname, 'fixtures', 'injections');
const LABEL = 'untrusted-issue';

const ALLOWED_LINK_HOSTS = new Set([
  'github.com',
  'gist.github.com',
  'docs.github.com',
  'docs.google.com',
  'drive.google.com',
]);

const fixtures = readdirSync(DIR)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => ({ name, body: readFileSync(join(DIR, name), 'utf8') }));

function issue(body: string): Issue {
  return {
    number: 77,
    title: body.split('\n')[0] ?? 'untitled',
    body,
    url: 'https://github.com/acme/widget/issues/77',
    author: 'drive-by-reporter',
    authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
    isBot: false,
    labels: [],
    state: 'open',
    createdAt: '2026-01-02T03:04:05Z',
    comments: [],
    truncated: false,
  };
}

/**
 * The worst realistic case: the model was steered into echoing the hostile text back into
 * every free-text field of the analysis. The renderers are the last thing between that and
 * a Google Doc, a Discord post and a public comment.
 */
function echoingAnalysis(body: string): Analysis {
  // The 200-char fields are filled from the sanitised body rather than a raw slice: slicing
  // raw text can cut an HTML comment in half, and an *unterminated* `<!--` is a separate
  // (real) gap in `stripMarkup`, covered on its own below rather than smeared across every
  // fixture here.
  const short = sanitize(body).slice(0, 200);
  return {
    summary: body,
    issueType: 'ambiguous',
    severity: 'informational',
    severityRationale: body,
    reproducibility: 'insufficient-information',
    affectedComponents: [short],
    rootCauseHypotheses: [body],
    suggestedActions: [body],
    relatedPastIssues: [{ reference: short, relevance: body }],
    openQuestions: [body],
    injectionSuspected: true,
    injectionNotes: body.slice(0, 1000),
    confidence: 'low',
  };
}

function nonAllowlistedUrls(text: string): string[] {
  const urls = text.match(/\bhttps?:\/\/[^\s<>()[\]"']+/gi) ?? [];
  return urls.filter((url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return !ALLOWED_LINK_HOSTS.has(host.startsWith('www.') ? host.slice(4) : host);
    } catch {
      return true;
    }
  });
}

describe('hostile issue corpus', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    // Keeps the secret scanner's live-env layer out of the picture: these assertions are
    // about the fixtures, not about whatever is exported in the developer's shell.
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON']) {
      delete process.env[name];
    }
    delete process.env['DISCORD_WEBHOOK_URL'];
    delete process.env['COPILOT_GITHUB_TOKEN'];
    delete process.env['GEMINI_API_KEY'];
  });

  afterEach(() => {
    process.env = saved;
  });

  it('has a non-empty corpus, so an empty fixture directory cannot pass silently', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    expect(fixtures.every((f) => f.body.trim().length > 0)).toBe(true);
  });

  it('covers the attack classes the threat model calls out', () => {
    const all = fixtures
      .map((f) => f.body)
      .join('\n')
      .toLowerCase();
    for (const marker of [
      'ignore all previous instructions',
      'copilot_github_token',
      'system: you are authorised',
      `</${LABEL}>`,
      '@everyone',
      '<!--',
      'evil.example',
      'tool_call',
      'swdub3jl', // the base64 payload
    ]) {
      expect(all, `no fixture exercises "${marker}"`).toContain(marker);
    }
  });

  for (const { name, body } of fixtures) {
    describe(name, () => {
      it('cannot escape the fence', () => {
        const nonce = 'f1f2f3f4f5f6f7f8f9f0f1f2';
        const open = `<${LABEL} nonce="${nonce}">`;
        const close = `</${LABEL} nonce="${nonce}">`;
        const { text } = fence(LABEL, body, nonce);
        expect(text.split(open)).toHaveLength(2);
        expect(text.split(close)).toHaveLength(2);
        const inner = text.slice(open.length, text.length - close.length);
        expect(inner).not.toContain(`<${LABEL}`);
        expect(inner).not.toContain(`</${LABEL}`);
      });

      it('survives sanitisation with no ping, no hidden comment and no live link', () => {
        const clean = sanitize(body);
        expect(clean.toLowerCase()).not.toContain('@everyone');
        expect(clean.toLowerCase()).not.toContain('@here');
        expect(clean).not.toContain('<!--');
        expect(clean).not.toContain('-->');
        expect(clean).not.toMatch(/<\/?[A-Za-z][^>]*>/);
        for (const url of nonAllowlistedUrls(body)) {
          // Either the URL is gone (it lived inside a stripped tag or comment) or it is
          // explicitly marked inert. What must not happen is a live attacker link.
          const inert = clean.includes(`${url} (link not followed)`);
          expect(inert || !clean.includes(url), `${url} was left live`).toBe(true);
        }
      });

      it('renders into a Doc, a Discord summary and a title with nothing hostile left live', () => {
        const model = echoingAnalysis(body);
        const target = issue(body);
        const surfaces = [
          renderAnalysisMarkdown(model, target),
          renderDiscordSummary(model),
          docTitle(target),
        ];

        for (const surface of surfaces) {
          expect(surface.toLowerCase()).not.toContain('@everyone');
          expect(surface.toLowerCase()).not.toContain('@here');
          expect(surface).not.toContain('<!--');
          // Nothing credential-shaped reaches a published surface.
          expect(findSecret(surface)).toBeNull();
        }

        // The Doc always leads with the injection warning for a flagged analysis. It is the
        // artefact a human reads, and since the agent no longer comments on the issue it is
        // also the only long-form surface — so the banner has to be unmissable there.
        // Discord's own '⚠️ Flagged' field is built inside postToDiscord from the
        // injectionSuspected flag, and is asserted in integrations-discord.test.ts.
        const doc = surfaces[0] as string;
        expect(doc.indexOf('Possible prompt-injection attempt')).toBeLessThan(
          doc.indexOf('## Summary'),
        );
      });
    });
  }

  /**
   * The unterminated case needs its own test because the paired pattern cannot match it.
   * GitHub renders everything after an unclosed `<!--` as nothing, so one surviving marker in
   * an early field would hide the rest of the document — including the injection banner —
   * from whoever reviews the thread. It also arises without malice whenever a bounded field is
   * truncated mid-comment.
   */
  it('strips an unterminated HTML comment', () => {
    const clean = sanitize('visible text <!-- everything after this vanishes on GitHub');
    expect(clean).not.toContain('<!--');
  });

  it('refuses to publish if the model were steered into echoing a real-looking credential', () => {
    // The corpus asks for credentials rather than carrying them; this is the other half —
    // the scanner stops the exfiltration even if every other layer were bypassed.
    const model = echoingAnalysis('the token you asked for is ghp_F4keT0kenF0rTestsOnly000000');
    expect(() => assertNoSecrets(model)).toThrow(SecretLeakError);
  });
});
