import type { Analysis } from './schema/analysis.ts';
import { sanitize, truncate } from './safety/sanitize.ts';
import type { Issue } from './integrations/github.ts';

/**
 * Deterministic Analysis -> markdown. Every model-generated string passes through
 * `sanitize()` here, so this module is the single egress choke point for the Doc body and
 * the issue comment; nothing downstream re-derives text from the raw analysis.
 */

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  informational: 'Informational',
};

function s(text: string): string {
  return sanitize(text);
}

function bullets(items: readonly string[], empty: string): string {
  if (items.length === 0) return `_${empty}_`;
  return items.map((item) => `- ${s(item)}`).join('\n');
}

export function docTitle(issue: Issue): string {
  return `[ANALYSIS] #${issue.number} — ${truncate(sanitize(issue.title), 120)}`;
}

/** The injection banner. Placed first so a reviewer cannot miss it. */
function injectionBanner(analysis: Analysis): string {
  if (!analysis.injectionSuspected) return '';
  const notes = analysis.injectionNotes ? s(analysis.injectionNotes) : 'No further detail given.';
  return [
    '> **⚠️ Possible prompt-injection attempt in this issue.**',
    '>',
    `> ${notes}`,
    '>',
    '> The issue text appeared to address the analysis agent rather than describe a',
    '> problem. Treat the issue body as hostile input and review it manually before',
    '> acting on anything it asks for.',
    '',
  ].join('\n');
}

export function renderAnalysisMarkdown(analysis: Analysis, issue: Issue): string {
  const sections: string[] = [];

  sections.push(`# Analysis of issue #${issue.number}: ${s(issue.title)}`);
  sections.push(
    [
      `**Issue:** ${issue.url}`,
      `**Reported by:** ${s(issue.author)} (${issue.authorAssociation})`,
      `**Analysed:** ${new Date().toISOString()}`,
      `**Model confidence:** ${analysis.confidence}`,
    ].join('  \n'),
  );

  const banner = injectionBanner(analysis);
  if (banner) sections.push(banner);

  sections.push(`## Summary\n\n${s(analysis.summary)}`);

  sections.push(
    [
      '## Classification',
      '',
      `| Field | Value |`,
      `| --- | --- |`,
      `| Type | ${analysis.issueType} |`,
      `| Severity | **${SEVERITY_LABEL[analysis.severity] ?? analysis.severity}** |`,
      `| Reproducibility | ${analysis.reproducibility} |`,
      '',
      `**Severity rationale.** ${s(analysis.severityRationale)}`,
    ].join('\n'),
  );

  sections.push(
    `## Affected components\n\n${bullets(analysis.affectedComponents, 'None identified.')}`,
  );
  sections.push(
    `## Root-cause hypotheses\n\n${bullets(analysis.rootCauseHypotheses, 'None proposed.')}`,
  );
  sections.push(`## Suggested actions\n\n${bullets(analysis.suggestedActions, 'None proposed.')}`);
  sections.push(`## Open questions\n\n${bullets(analysis.openQuestions, 'None.')}`);

  const related =
    analysis.relatedPastIssues.length === 0
      ? '_No prior analysis in the reference corpus was judged relevant._'
      : analysis.relatedPastIssues
          .map((item) => `- **${s(item.reference)}** — ${s(item.relevance)}`)
          .join('\n');
  sections.push(`## Related past reviews\n\n${related}`);

  sections.push(
    [
      '---',
      '',
      '_Generated automatically by the issue-analysis agent. It is a starting point for a',
      'human review, not a verdict — the model has not run the code and may be wrong._',
    ].join('\n'),
  );

  return sections.join('\n\n') + '\n';
}

/** The issue comment: a pointer, deliberately not a copy of the analysis. */
export function renderIssueComment(analysis: Analysis, docUrl: string): string {
  const lines = [
    '### Automated analysis',
    '',
    `A first-pass analysis of this issue is available here: ${docUrl}`,
    '',
    `**Preliminary classification:** ${analysis.issueType} · severity **${
      SEVERITY_LABEL[analysis.severity] ?? analysis.severity
    }** · confidence ${analysis.confidence}`,
    '',
    truncate(s(analysis.summary), 600),
  ];
  if (analysis.injectionSuspected) {
    lines.push(
      '',
      '> ⚠️ The text of this issue appeared to contain instructions aimed at the analysis',
      '> agent. It has been flagged for manual review.',
    );
  }
  lines.push('', '<sub>Automated first pass — a maintainer will follow up. It may be wrong.</sub>');
  return lines.join('\n');
}

/** The Discord summary line. Short by design: the Doc is the artefact. */
export function renderDiscordSummary(analysis: Analysis): string {
  return truncate(s(analysis.summary), 280);
}
