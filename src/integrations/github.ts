import { Octokit } from '@octokit/rest';
import * as v from 'valibot';
import { githubToken } from '../env.ts';
import { CommentInputSchema, IssueRefSchema, type IssueRef } from '../schema/integrations.ts';

/**
 * GitHub read + comment. `fetchIssue` is the point where attacker-controlled text enters
 * the process, so it is also where that text gets bounded: an issue body has no practical
 * length limit, and an unbounded body is a direct route to an enormous context bill.
 */

/** Generous enough for a detailed report, small enough to bound cost. */
export const MAX_BODY_CHARS = 20_000;
export const MAX_COMMENT_CHARS = 4_000;
export const MAX_COMMENTS = 20;

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  /** OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR / NONE. */
  authorAssociation: string;
  isBot: boolean;
  labels: string[];
  state: string;
  createdAt: string;
  /** Existing discussion, oldest first, bounded. */
  comments: Array<{ author: string; body: string }>;
  /** True when any field above was cut, so the prompt can say so honestly. */
  truncated: boolean;
}

function client(): Octokit {
  return new Octokit({ auth: githubToken(), userAgent: 'issue-analysis-agent' });
}

export async function fetchIssue(ref: IssueRef, octokit: Octokit = client()): Promise<Issue> {
  const { owner, repo, issueNumber } = v.parse(IssueRefSchema, ref);

  const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
  const { data: rawComments } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: MAX_COMMENTS,
  });

  const body = issue.body ?? '';
  let truncated = body.length > MAX_BODY_CHARS || rawComments.length >= MAX_COMMENTS;

  // `per_page` is a request for a bound, not a guarantee of one — a proxy or a GHE release
  // that over-returns would push every extra comment into the prompt. Slice defensively, the
  // same way the body is sliced rather than trusted.
  const comments = rawComments.slice(0, MAX_COMMENTS).map((comment) => {
    const commentBody = comment.body ?? '';
    if (commentBody.length > MAX_COMMENT_CHARS) truncated = true;
    return {
      author: comment.user?.login ?? 'unknown',
      body: commentBody.slice(0, MAX_COMMENT_CHARS),
    };
  });

  return {
    number: issue.number,
    title: (issue.title ?? '').slice(0, 300),
    body: body.slice(0, MAX_BODY_CHARS),
    url: issue.html_url,
    author: issue.user?.login ?? 'unknown',
    authorAssociation: issue.author_association ?? 'NONE',
    isBot: issue.user?.type === 'Bot',
    labels: issue.labels
      .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      .filter((name) => name.length > 0)
      .slice(0, 30),
    state: issue.state,
    createdAt: issue.created_at,
    comments,
    truncated,
  };
}

export async function commentOnIssue(
  input: v.InferInput<typeof CommentInputSchema>,
  octokit: Octokit = client(),
): Promise<{ url: string }> {
  const { owner, repo, issueNumber, body } = v.parse(CommentInputSchema, input);
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return { url: data.html_url };
}
