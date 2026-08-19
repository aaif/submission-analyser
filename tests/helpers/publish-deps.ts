/**
 * Recording fakes for the publish tool's side-effect seam.
 *
 * `publishDeps` is a module-level mutable object, so every test that touches it must put it
 * back: `installRecordingDeps` returns a `restore()` that reinstates the exact original
 * members. Without that, one test's fake Drive would still be installed for the next file.
 */

import { publishDeps, type PublishDeps } from '../../src/tools/analyze-and-publish.ts';
import { SAMPLE_ISSUE } from '../../src/faux.ts';
import type { Issue } from '../../src/integrations/github.ts';
import type { CreateDocInput } from '../../src/schema/integrations.ts';
import type { CommentInput } from '../../src/schema/integrations.ts';
import type { DiscordPostInput } from '../../src/schema/integrations.ts';

export interface PublishRecord {
  fetched: Array<{ owner: string; repo: string; issueNumber: number }>;
  docs: CreateDocInput[];
  comments: CommentInput[];
  discord: DiscordPostInput[];
  /** Every side effect in the order it happened, for cross-integration ordering assertions. */
  order: string[];
}

export interface RecordingDepsOptions {
  issue?: Partial<Issue>;
  docUrl?: string;
  commentUrl?: string;
  /** Thrown by the corresponding fake instead of succeeding. */
  failDoc?: Error;
  failComment?: Error;
  failDiscord?: Error;
}

export interface InstalledDeps {
  record: PublishRecord;
  restore: () => void;
}

export function installRecordingDeps(options: RecordingDepsOptions = {}): InstalledDeps {
  const original: PublishDeps = { ...publishDeps };
  const record: PublishRecord = { fetched: [], docs: [], comments: [], discord: [], order: [] };
  const issue: Issue = { ...SAMPLE_ISSUE, ...options.issue };

  publishDeps.resolveFolderId = () => 'test-drive-folder';

  publishDeps.fetchIssue = async (ref) => {
    record.fetched.push({ owner: ref.owner, repo: ref.repo, issueNumber: ref.issueNumber });
    record.order.push('fetchIssue');
    return { ...issue, number: ref.issueNumber };
  };

  publishDeps.createAnalysisDoc = async (input) => {
    record.docs.push(input as CreateDocInput);
    record.order.push('createAnalysisDoc');
    if (options.failDoc) throw options.failDoc;
    const url = options.docUrl ?? 'https://docs.google.com/document/d/test-doc/edit';
    return { id: 'test-doc', url };
  };

  publishDeps.commentOnIssue = async (input) => {
    record.comments.push(input as CommentInput);
    record.order.push('commentOnIssue');
    if (options.failComment) throw options.failComment;
    return {
      url: options.commentUrl ?? 'https://github.com/acme/widget/issues/1#issuecomment-99',
    };
  };

  publishDeps.postToDiscord = async (input) => {
    record.discord.push(input as DiscordPostInput);
    record.order.push('postToDiscord');
    if (options.failDiscord) throw options.failDiscord;
  };

  return {
    record,
    restore: () => {
      Object.assign(publishDeps, original);
    },
  };
}
