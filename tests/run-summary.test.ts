import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRunResult, writeRunSummary } from '../src/run-summary.ts';

/**
 * These two functions are the workflow's only window into what a run did, so their contract
 * is a CI contract, not a logging nicety: `.github/workflows/issue-analyst.yml` parses the
 * result file with `JSON.parse` and fails the job on anything it does not recognise. A
 * silently malformed line here would fail every run after a Doc had already been created.
 */
describe('run summary and result files', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-summary-'));
    delete process.env.GITHUB_STEP_SUMMARY;
    delete process.env.AGENT_RESULT_JSON;
  });

  afterEach(() => {
    delete process.env.GITHUB_STEP_SUMMARY;
    delete process.env.AGENT_RESULT_JSON;
  });

  describe('writeRunSummary', () => {
    it('appends a markdown table of the rows it was given', () => {
      const path = join(dir, 'summary.md');
      writeFileSync(path, '');
      process.env.GITHUB_STEP_SUMMARY = path;

      writeRunSummary({ repository: 'acme/widget', issue: '#412' });

      const written = readFileSync(path, 'utf8');
      expect(written).toContain('| repository | acme/widget |');
      expect(written).toContain('| issue | #412 |');
      expect(written.endsWith('\n')).toBe(true);
    });

    it('appends rather than truncating, so two calls in one step both survive', () => {
      const path = join(dir, 'summary-twice.md');
      writeFileSync(path, '');
      process.env.GITHUB_STEP_SUMMARY = path;

      writeRunSummary({ first: 1 });
      writeRunSummary({ second: 2 });

      const written = readFileSync(path, 'utf8');
      expect(written).toContain('| first | 1 |');
      expect(written).toContain('| second | 2 |');
    });

    it('does nothing when GITHUB_STEP_SUMMARY is unset, which is the local case', () => {
      expect(() => writeRunSummary({ repository: 'acme/widget' })).not.toThrow();
    });

    it('swallows an unwritable path — a job page decoration must not fail a run', () => {
      // A directory that does not exist: appendFileSync throws ENOENT.
      process.env.GITHUB_STEP_SUMMARY = join(dir, 'absent', 'summary.md');
      expect(() => writeRunSummary({ repository: 'acme/widget' })).not.toThrow();
    });
  });

  describe('writeRunResult', () => {
    it('writes one line of JSON the workflow can parse', () => {
      const path = join(dir, 'result.json');
      process.env.AGENT_RESULT_JSON = path;

      writeRunResult({
        status: 'published',
        repository: 'acme/widget',
        issueNumber: 412,
        docUrl: 'https://docs.google.com/document/d/abc/edit',
        severity: 'high',
        injectionSuspected: false,
      });

      const raw = readFileSync(path, 'utf8');
      expect(raw.trimEnd().split('\n')).toHaveLength(1);
      // Types are preserved, because the assert step compares `=== 'published'` and reads
      // `injectionSuspected` as a boolean rather than as the string "false".
      expect(JSON.parse(raw)).toEqual({
        status: 'published',
        repository: 'acme/widget',
        issueNumber: 412,
        docUrl: 'https://docs.google.com/document/d/abc/edit',
        severity: 'high',
        injectionSuspected: false,
      });
    });

    it('overwrites, so a fallback run in the same workspace cannot be read as the primary', () => {
      const path = join(dir, 'result-overwrite.json');
      process.env.AGENT_RESULT_JSON = path;

      writeRunResult({ status: 'dry-run', repository: 'acme/widget', issueNumber: 1 });
      writeRunResult({ status: 'published', repository: 'acme/widget', issueNumber: 2 });

      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        status: 'published',
        repository: 'acme/widget',
        issueNumber: 2,
      });
    });

    it('does nothing when AGENT_RESULT_JSON is unset', () => {
      expect(() => writeRunResult({ status: 'published' })).not.toThrow();
    });

    it('swallows an unwritable path, leaving the assert step to report the missing file', () => {
      // Deliberate: throwing here would surface as an opaque tool failure *after* the Doc
      // exists, instead of as the workflow assertion that knows what the file was for.
      process.env.AGENT_RESULT_JSON = join(dir, 'absent', 'result.json');
      expect(() => writeRunResult({ status: 'published' })).not.toThrow();
    });
  });
});
