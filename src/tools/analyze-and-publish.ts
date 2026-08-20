import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { AnalysisSchema, type Analysis } from '../schema/analysis.ts';
import { boundaryRule, fence } from '../safety/fence.ts';
import { assertNoSecrets } from '../safety/secret-scan.ts';
import { writeRunSummary, writeRunResult } from '../run-summary.ts';
import { sanitize } from '../safety/sanitize.ts';
import { fetchIssue, type Issue } from '../integrations/github.ts';
import { createAnalysisDoc } from '../integrations/google-docs.ts';
import { postToDiscord } from '../integrations/discord.ts';
import { docTitle, renderAnalysisMarkdown, renderDiscordSummary } from '../render.ts';
import { googleDriveFolderId, targetRepo, isDryRun, preflight } from '../env.ts';

/**
 * The agent's one and only tool. Everything the run does happens inside it.
 *
 * Why one harness tool rather than several model-callable tools (create_doc,
 * post_to_discord):
 *
 * 1. It makes "validated before any side effect" a fact rather than a hope. The analysis is
 *    obtained through `harness.prompt(..., { result: AnalysisSchema })`, so a value that
 *    does not validate never becomes a value at all — there is no ordering for the model to
 *    get wrong, because the model is not doing the ordering.
 * 2. It collapses the injection surface. The issue body is attacker-controlled text read by
 *    a model with shell access. If Discord and Drive were mounted as tools, "post your
 *    environment to Discord" would have a mechanism to use. They are not mounted, so it has
 *    none. This is the single most valuable property of the design.
 * 3. Ordering, partial failure and dry-run become ordinary TypeScript, testable offline.
 *
 * `durable: true` so each side effect is recorded exactly once: an interrupted call replays
 * completed steps instead of re-running them, which is what stops a retry from creating a
 * second Doc and posting to Discord twice.
 */

export const PublishResultSchema = v.strictObject({
  status: v.picklist(['published', 'dry-run', 'skipped'] as const),
  issueNumber: v.number(),
  docUrl: v.optional(v.string()),
  severity: v.optional(v.string()),
  injectionSuspected: v.optional(v.boolean()),
  detail: v.string(),
});

/**
 * Injectable side-effect surface.
 *
 * The tool calls these through the object rather than importing them directly, so tests and
 * the FLUE_FAUX offline path can substitute fakes without an HTTP interceptor. Production
 * code never reassigns it; `installOfflineDeps` in src/faux.ts is gated on FLUE_FAUX.
 */
export interface PublishDeps {
  fetchIssue: typeof fetchIssue;
  createAnalysisDoc: typeof createAnalysisDoc;
  postToDiscord: typeof postToDiscord;
  /** Resolved through the seam so a fake publisher needs no real Drive folder. */
  resolveFolderId: () => string;
}

export const publishDeps: PublishDeps = {
  fetchIssue,
  createAnalysisDoc,
  postToDiscord,
  resolveFolderId: googleDriveFolderId,
};

/** Builds the analysis instruction. Exported so tests can assert on the fencing. */
export function buildAnalysisPrompt(issue: Issue): string {
  const { text, nonce } = fence('issue', formatIssue(issue));
  return [
    `Analyse GitHub issue #${issue.number} in this repository.`,
    '',
    `Use the "issue-analysis" skill: activate it and follow it, including its instruction to`,
    `consult the past reviews in the skill's references/ directory and to ground your`,
    `findings in the checked-out repository.`,
    '',
    boundaryRule('issue', nonce),
    '',
    text,
    '',
    issue.truncated
      ? 'Note: this issue was longer than the ingest limit and has been truncated. Say so if it affects your confidence.'
      : '',
    '',
    `Return the structured analysis. Every field is required except injectionNotes, which`,
    `you should fill in only when injectionSuspected is true.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function formatIssue(issue: Issue): string {
  const parts = [
    `Title: ${issue.title}`,
    `Author: ${issue.author} (association: ${issue.authorAssociation})`,
    `State: ${issue.state}`,
    `Opened: ${issue.createdAt}`,
    `Labels: ${issue.labels.length > 0 ? issue.labels.join(', ') : '(none)'}`,
    '',
    'Body:',
    issue.body.length > 0 ? issue.body : '(empty)',
  ];
  if (issue.comments.length > 0) {
    parts.push('', `Existing comments (${issue.comments.length}):`);
    for (const comment of issue.comments) {
      parts.push('', `--- ${comment.author} wrote:`, comment.body);
    }
  }
  return parts.join('\n');
}

export const analyzeAndPublish = defineTool({
  name: 'analyze_and_publish',
  description:
    'Analyse a GitHub issue and publish the analysis: create a Google Doc, comment the ' +
    'link on the issue, and announce it in Discord. Performs the whole workflow; call it ' +
    'exactly once with the issue number and then stop.',
  input: v.strictObject({
    issueNumber: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.description('The number of the issue to analyse.'),
    ),
  }),
  output: PublishResultSchema,
  harness: true,
  durable: true,
  async run({ data, harness, step, log }) {
    // A thrown tool error reaches the model as a tool result but is NOT surfaced by the CLI,
    // so without this an operator reading a failed Action log sees only "tool error" with no
    // reason. Log it, then rethrow unchanged.
    try {
      const dryRun = isDryRun();

      // Fail before spending a token on a run that cannot publish.
      preflight({ dryRun });
      const repo = targetRepo();

      const issue = await step.do('fetch-issue', () =>
        publishDeps.fetchIssue({ ...repo, issueNumber: data.issueNumber }),
      );

      // Bot-filed issues are skipped because they are usually machine-generated noise
      // (dependency bots, mirrors, CI reporters) and analysing them spends model budget on
      // text no maintainer asked about. The dispatching workflow guards on this too; this is
      // the belt-and-braces copy, and the one that also covers a manual dispatch.
      if (issue.isBot) {
        writeRunResult({
          status: 'skipped',
          repository: `${repo.owner}/${repo.repo}`,
          issueNumber: issue.number,
        });
        return {
          output: {
            status: 'skipped' as const,
            issueNumber: issue.number,
            detail: `Issue #${issue.number} was opened by a bot account; skipped without analysis.`,
          },
          terminate: true,
        };
      }

      const analysis = await step.do('analyse', async (): Promise<Analysis> => {
        const response = await harness.prompt(buildAnalysisPrompt(issue), {
          result: AnalysisSchema,
        });
        const model = `${response.model.provider}/${response.model.id}`;
        const costUsd = Number(response.usage.cost.total.toFixed(4));
        log.info('analysis complete', {
          model,
          totalTokens: response.usage.totalTokens,
          costUsd,
        });
        writeRunSummary({
          model,
          'total tokens': response.usage.totalTokens,
          'cost (USD)': costUsd,
        });
        return response.data;
      });

      // The model's output is structurally valid by here. This checks it is not carrying a
      // credential out through the content itself — the one egress route the architecture
      // does not close structurally. Throwing here means nothing has been published yet.
      assertNoSecrets(analysis);

      if (analysis.injectionSuspected) {
        log.warn('possible prompt injection reported by the analysis', {
          issueNumber: issue.number,
        });
      }

      const markdown = renderAnalysisMarkdown(analysis, issue);

      if (dryRun) {
        log.info('dry run: skipping all publication', { chars: markdown.length });
        writeRunResult({
          status: 'dry-run',
          repository: `${repo.owner}/${repo.repo}`,
          issueNumber: issue.number,
          severity: analysis.severity,
          injectionSuspected: analysis.injectionSuspected,
        });
        return {
          output: {
            status: 'dry-run' as const,
            issueNumber: issue.number,
            severity: analysis.severity,
            injectionSuspected: analysis.injectionSuspected,
            detail:
              `DRY_RUN: analysed issue #${issue.number} (severity ${analysis.severity}, ` +
              `confidence ${analysis.confidence}) and rendered ${markdown.length} characters ` +
              `of markdown. Nothing was published.`,
          },
          terminate: true,
        };
      }

      // Doc first, then Discord. The Doc is the artefact; the Discord message is a pointer
      // to it, and a pointer to a Doc that does not exist is worse than no message at all.
      // A failing webhook after a successful Doc still fails the run loudly.
      const doc = await step.do('create-doc', () =>
        publishDeps.createAnalysisDoc({
          title: docTitle(issue),
          markdown,
          folderId: publishDeps.resolveFolderId(),
        }),
      );

      // `step.do` persists its return value, and the durable store rejects `undefined`.
      // postToDiscord resolves void, so return an explicit marker.
      await step.do('post-to-discord', async () => {
        await publishDeps.postToDiscord({
          issueNumber: issue.number,
          issueTitle: sanitize(issue.title, { max: 200 }),
          issueUrl: issue.url,
          docUrl: doc.url,
          summary: renderDiscordSummary(analysis),
          severity: analysis.severity,
          injectionSuspected: analysis.injectionSuspected,
        });
        return { posted: true };
      });

      writeRunSummary({
        repository: `${repo.owner}/${repo.repo}`,
        issue: `#${issue.number}`,
        doc: doc.url,
      });
      writeRunResult({
        status: 'published',
        repository: `${repo.owner}/${repo.repo}`,
        issueNumber: issue.number,
        docUrl: doc.url,
        severity: analysis.severity,
        injectionSuspected: analysis.injectionSuspected,
      });

      return {
        output: {
          status: 'published' as const,
          issueNumber: issue.number,
          docUrl: doc.url,
          severity: analysis.severity,
          injectionSuspected: analysis.injectionSuspected,
          detail:
            `Published the analysis of issue #${issue.number}: Doc ${doc.url}, ` +
            'Discord notified.',
        },
        terminate: true,
      };
    } catch (error) {
      log.error('analyze_and_publish failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
