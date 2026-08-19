import { appendFileSync } from 'node:fs';

/**
 * Writes a one-line-per-fact run summary where a human and a workflow can both read it.
 *
 * This exists because `log.info` is not enough on its own. Flue's logger emits structured
 * events into the conversation activity stream, and the CLI presenter renders only message
 * and tool events — `flue run` has no verbosity flag. So a cost line logged during a CI run
 * lands in the run database and nowhere a person will look. Non-functional requirement 5
 * ("under $0.50 per run") is not a requirement if the number is unobservable.
 *
 * GITHUB_STEP_SUMMARY is the right channel: GitHub sets it on every step, renders the file as
 * markdown in the job page, and it costs nothing locally where the variable is unset.
 *
 * Only ever called with values this code produced — model ids, token counts, a Doc URL. Never
 * with issue text, and never with anything read from the environment.
 */
export function writeRunSummary(rows: Record<string, string | number | boolean>): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines = Object.entries(rows).map(([key, value]) => `| ${key} | ${value} |`);
  const table = ['| | |', '| --- | --- |', ...lines, ''].join('\n');
  try {
    appendFileSync(path, table);
  } catch {
    // A summary is diagnostics. Failing the run because the job page could not be decorated
    // would trade something that matters for something that does not.
  }
}
