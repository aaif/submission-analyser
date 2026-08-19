/**
 * src/integrations/github.ts — the ingest and comment boundary.
 *
 * `fetchIssue` is where attacker-controlled text enters the process, so the assertions here
 * are mostly about bounds: an unbounded issue body is a direct route to an enormous context
 * bill, and `truncated` has to be honest so the prompt can say so.
 *
 * The Octokit instance is a parameter, so a hand-rolled stub shaped to the three calls the
 * code makes is enough — no module mocking and no GITHUB_TOKEN.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_BODY_CHARS,
  MAX_COMMENT_CHARS,
  MAX_COMMENTS,
  commentOnIssue,
  fetchIssue,
  type Issue,
} from '../src/integrations/github.ts';
import { NO_CREDENTIALS, applyEnv, restoreEnv, snapshotEnv } from './helpers/env.ts';
import { BASE_ISSUE, stubOctokit, type StubComment } from './helpers/octokit.ts';

const REF = { owner: 'acme', repo: 'widget', issueNumber: 7 };

function comments(count: number, body = 'a comment'): StubComment[] {
  return Array.from({ length: count }, (_unused, index) => ({
    body,
    user: { login: `commenter-${index}` },
  }));
}

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = snapshotEnv();
  // No GITHUB_TOKEN: the Octokit instance is always injected, so the default `client()` path
  // — the only thing that reads a token — must never be reached.
  applyEnv(NO_CREDENTIALS);
});

afterEach(() => restoreEnv(envSnapshot));

describe('fetchIssue — bounds', () => {
  it('reads a normal issue without marking it truncated', async () => {
    const { octokit, calls } = stubOctokit();
    const issue = await fetchIssue(REF, octokit);

    expect(issue.truncated).toBe(false);
    expect(issue.number).toBe(BASE_ISSUE.number);
    expect(issue.body).toBe(BASE_ISSUE.body);
    expect(issue.url).toBe(BASE_ISSUE.html_url);
    expect(issue.labels).toEqual(['bug', 'queue']);
    expect(issue.state).toBe('open');
    expect(issue.createdAt).toBe(BASE_ISSUE.created_at);
    expect(calls.map((call) => call.method)).toEqual(['get', 'listComments']);
    expect(calls[0]!.params).toEqual({ owner: 'acme', repo: 'widget', issue_number: 7 });
  });

  it('truncates a body over MAX_BODY_CHARS and sets truncated: true', async () => {
    const body = 'x'.repeat(MAX_BODY_CHARS + 500);
    const { octokit } = stubOctokit({ issue: { body } });
    const issue = await fetchIssue(REF, octokit);

    expect(issue.body).toHaveLength(MAX_BODY_CHARS);
    expect(issue.truncated).toBe(true);
  });

  it('leaves a body exactly at MAX_BODY_CHARS untouched and untruncated', async () => {
    const body = 'x'.repeat(MAX_BODY_CHARS);
    const { octokit } = stubOctokit({ issue: { body } });
    const issue = await fetchIssue(REF, octokit);

    expect(issue.body).toHaveLength(MAX_BODY_CHARS);
    expect(issue.truncated).toBe(false);
  });

  it('treats a null body as empty', async () => {
    const { octokit } = stubOctokit({ issue: { body: null } });
    const issue = await fetchIssue(REF, octokit);
    expect(issue.body).toBe('');
    expect(issue.truncated).toBe(false);
  });

  it('caps each comment at MAX_COMMENT_CHARS and reports truncation', async () => {
    const long = 'y'.repeat(MAX_COMMENT_CHARS + 100);
    const { octokit } = stubOctokit({ comments: [{ body: long, user: { login: 'chatty' } }] });
    const issue = await fetchIssue(REF, octokit);

    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.body).toHaveLength(MAX_COMMENT_CHARS);
    expect(issue.comments[0]!.author).toBe('chatty');
    expect(issue.truncated).toBe(true);
  });

  it('bounds the comment fetch to MAX_COMMENTS via per_page', async () => {
    const { octokit, calls } = stubOctokit({ comments: comments(3) });
    await fetchIssue(REF, octokit);

    const listCall = calls.find((call) => call.method === 'listComments');
    expect(listCall?.params).toEqual({
      owner: 'acme',
      repo: 'widget',
      issue_number: 7,
      per_page: MAX_COMMENTS,
    });
  });

  it('marks truncated when the comment page came back full', async () => {
    const { octokit } = stubOctokit({ comments: comments(MAX_COMMENTS) });
    const issue = await fetchIssue(REF, octokit);

    expect(issue.comments).toHaveLength(MAX_COMMENTS);
    expect(issue.truncated).toBe(true);
  });

  /**
   * KNOWN GAP in src/integrations/github.ts — do not "fix" this test.
   *
   * `per_page: MAX_COMMENTS` asks the API for a bound; it does not guarantee one. A proxy, a
   * GitHub Enterprise instance with a different default, or a client that auto-paginates could
   * all return more, and every extra comment would flow into the prompt with the context bound
   * silently gone. So the cap is also enforced locally, the same way the body is sliced rather
   * than trusted. This test drives the API stub past the page size on purpose.
   */
  it('caps the comment list at MAX_COMMENTS regardless of what the API returns', async () => {
    const { octokit } = stubOctokit({ comments: comments(MAX_COMMENTS + 5) });
    const issue = await fetchIssue(REF, octokit);
    expect(issue.comments.length).toBeLessThanOrEqual(MAX_COMMENTS);
  });

  it('truncates a very long title', async () => {
    const { octokit } = stubOctokit({ issue: { title: 'T'.repeat(500) } });
    const issue = await fetchIssue(REF, octokit);
    expect(issue.title).toHaveLength(300);
  });

  it('caps the label list', async () => {
    const labels = Array.from({ length: 40 }, (_unused, index) => ({ name: `label-${index}` }));
    const { octokit } = stubOctokit({ issue: { labels } });
    const issue = await fetchIssue(REF, octokit);
    expect(issue.labels).toHaveLength(30);
  });
});

describe('fetchIssue — author provenance', () => {
  it('surfaces authorAssociation as GitHub reported it', async () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR', 'FIRST_TIME_CONTRIBUTOR']) {
      const { octokit } = stubOctokit({ issue: { author_association: association } });
      const issue = await fetchIssue(REF, octokit);
      expect(issue.authorAssociation).toBe(association);
    }
  });

  it('defaults authorAssociation to NONE when absent', async () => {
    const { octokit } = stubOctokit({ issue: { author_association: undefined } });
    const issue = await fetchIssue(REF, octokit);
    expect(issue.authorAssociation).toBe('NONE');
  });

  it('sets isBot for a Bot-type author — the comment-loop guard depends on it', async () => {
    const { octokit } = stubOctokit({ issue: { user: { login: 'dependabot[bot]', type: 'Bot' } } });
    const issue = await fetchIssue(REF, octokit);
    expect(issue.isBot).toBe(true);
    expect(issue.author).toBe('dependabot[bot]');
  });

  it('sets isBot false for a human author and for a missing author', async () => {
    const human = await fetchIssue(
      REF,
      stubOctokit({ issue: { user: { login: 'octocat', type: 'User' } } }).octokit,
    );
    expect(human.isBot).toBe(false);

    const anonymous = await fetchIssue(REF, stubOctokit({ issue: { user: null } }).octokit);
    expect(anonymous.isBot).toBe(false);
    expect(anonymous.author).toBe('unknown');
  });
});

describe('fetchIssue — errors', () => {
  it('propagates an issues.get failure', async () => {
    const { octokit } = stubOctokit({ getError: new Error('Not Found') });
    await expect(fetchIssue(REF, octokit)).rejects.toThrow('Not Found');
  });

  it('propagates an issues.listComments failure', async () => {
    const { octokit } = stubOctokit({ listCommentsError: new Error('API rate limit exceeded') });
    await expect(fetchIssue(REF, octokit)).rejects.toThrow('API rate limit exceeded');
  });

  it('rejects a malformed ref before calling the API', async () => {
    const { octokit, calls } = stubOctokit();
    await expect(fetchIssue({ ...REF, owner: 'acme/evil' }, octokit)).rejects.toThrow();
    await expect(fetchIssue({ ...REF, issueNumber: 0 }, octokit)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('commentOnIssue', () => {
  it('posts to the right owner/repo/issue and returns the comment URL', async () => {
    const { octokit, calls } = stubOctokit({
      commentUrl: 'https://github.com/acme/widget/issues/7#issuecomment-1234',
    });
    const result = await commentOnIssue(
      { owner: 'acme', repo: 'widget', issueNumber: 7, body: 'Analysis: see the Doc.' },
      octokit,
    );

    expect(result).toEqual({ url: 'https://github.com/acme/widget/issues/7#issuecomment-1234' });
    expect(calls).toEqual([
      {
        method: 'createComment',
        params: {
          owner: 'acme',
          repo: 'widget',
          issue_number: 7,
          body: 'Analysis: see the Doc.',
        },
      },
    ]);
  });

  it('throws on an API error', async () => {
    const { octokit } = stubOctokit({ createCommentError: new Error('Resource not accessible') });
    await expect(commentOnIssue({ ...REF, body: 'anything' }, octokit)).rejects.toThrow(
      'Resource not accessible',
    );
  });

  it('rejects an empty body before calling the API', async () => {
    const { octokit, calls } = stubOctokit();
    await expect(commentOnIssue({ ...REF, body: '' }, octokit)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('the Issue interface', () => {
  it('is fully populated by fetchIssue — no field silently missing', async () => {
    const { octokit } = stubOctokit({ comments: comments(2) });
    const issue = await fetchIssue(REF, octokit);

    const keys: Array<keyof Issue> = [
      'number',
      'title',
      'body',
      'url',
      'author',
      'authorAssociation',
      'isBot',
      'labels',
      'state',
      'createdAt',
      'comments',
      'truncated',
    ];
    for (const key of keys) {
      expect(issue[key], `missing ${key}`).not.toBeUndefined();
    }
  });
});
