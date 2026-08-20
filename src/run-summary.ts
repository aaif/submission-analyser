import { appendFileSync, writeFileSync } from 'node:fs';

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

/**
 * Writes the run's outcome as JSON where the workflow's assert step can read it.
 *
 * Needed because the outcome cannot be recovered from the run output. The tool returns
 * `terminate: true`, so the model never gets a closing turn and `--json`'s `message` is
 * empty; and `@flue/cli`'s presenter renders tool *events* without their result payloads, so
 * the stderr log shows "tool done analyze_and_publish" and never the Doc URL. Since the
 * agent no longer comments on the issue, there is also no API-visible artefact to check.
 * Without this file, "the envelope said completed" would be the only available assertion —
 * and that is true of a dry run, a skipped bot issue, and a real publish alike.
 *
 * Same contract as writeRunSummary: only values this code produced, never issue text, never
 * anything read from the environment.
 */
export function writeRunResult(result: Record<string, string | number | boolean>): void {
  const path = process.env.AGENT_RESULT_JSON;
  if (!path) return;
  try {
    writeFileSync(path, `${JSON.stringify(result)}\n`);
  } catch {
    // Unlike the summary, a missing result file *will* fail the assert step — which is the
    // correct outcome. Swallow here so the failure is reported by the assertion that cares,
    // rather than as an opaque tool error after the Doc has already been created.
  }
}
