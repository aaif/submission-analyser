/**
 * A hand-rolled Octokit stub, shaped to exactly the three calls src/integrations/github.ts
 * makes: `issues.get`, `issues.listComments`, `issues.createComment`.
 *
 * Deliberately not `vi.mock('@octokit/rest')`: the module is injected as a parameter, so a
 * plain object is enough, and a stub with only the used methods means a change in what the
 * integration calls shows up as a TypeError here rather than as a silently-passing mock.
 */

import type { Octokit } from '@octokit/rest';

export interface StubIssuePayload {
  number?: number;
  title?: string | null;
  body?: string | null;
  html_url?: string;
  user?: { login?: string; type?: string } | null;
  author_association?: string;
  labels?: Array<string | { name?: string | null }>;
  state?: string;
  created_at?: string;
}

export interface StubComment {
  body?: string | null;
  user?: { login?: string } | null;
}

export interface OctokitCall {
  method: 'get' | 'listComments' | 'createComment';
  params: Record<string, unknown>;
}

export interface StubOctokit {
  octokit: Octokit;
  calls: OctokitCall[];
}

export interface StubOctokitOptions {
  issue?: StubIssuePayload;
  comments?: StubComment[];
  commentUrl?: string;
  getError?: Error;
  listCommentsError?: Error;
  createCommentError?: Error;
}

export const BASE_ISSUE: Required<
  Pick<
    StubIssuePayload,
    | 'number'
    | 'title'
    | 'body'
    | 'html_url'
    | 'user'
    | 'author_association'
    | 'labels'
    | 'state'
    | 'created_at'
  >
> = {
  number: 7,
  title: 'Consumer redelivers jobs after restart',
  body: 'Restarting the consumer mid-batch redelivers in-flight jobs.',
  html_url: 'https://github.com/acme/widget/issues/7',
  user: { login: 'octocat', type: 'User' },
  author_association: 'CONTRIBUTOR',
  labels: [{ name: 'bug' }, 'queue'],
  state: 'open',
  created_at: '2026-08-01T00:00:00Z',
};

export function stubOctokit(options: StubOctokitOptions = {}): StubOctokit {
  const calls: OctokitCall[] = [];
  const issue = { ...BASE_ISSUE, ...options.issue };
  const comments = options.comments ?? [];

  const issues = {
    async get(params: Record<string, unknown>) {
      calls.push({ method: 'get', params });
      if (options.getError) throw options.getError;
      return { data: issue };
    },
    async listComments(params: Record<string, unknown>) {
      calls.push({ method: 'listComments', params });
      if (options.listCommentsError) throw options.listCommentsError;
      return { data: comments };
    },
    async createComment(params: Record<string, unknown>) {
      calls.push({ method: 'createComment', params });
      if (options.createCommentError) throw options.createCommentError;
      return {
        data: {
          html_url: options.commentUrl ?? 'https://github.com/acme/widget/issues/7#issuecomment-42',
        },
      };
    },
  };

  return { octokit: { issues } as unknown as Octokit, calls };
}
