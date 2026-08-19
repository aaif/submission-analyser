import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  AnalysisSchema,
  ISSUE_TYPES,
  REPRODUCIBILITY,
  SEVERITIES,
  type Analysis,
} from '../src/schema/analysis.ts';

/** A minimal analysis that validates, so each test can perturb exactly one field. */
function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'The queue redelivers messages after a broker restart.',
    issueType: 'bug',
    severity: 'high',
    severityRationale: 'Duplicate delivery corrupts downstream ledger state.',
    reproducibility: 'reproducible',
    affectedComponents: ['queue/dispatcher'],
    rootCauseHypotheses: ['The ack cursor is persisted after the redelivery sweep.'],
    suggestedActions: ['Add a restart-crossing integration test.'],
    relatedPastIssues: [{ reference: '#412', relevance: 'Same ack-cursor ordering.' }],
    openQuestions: ['Which broker version was in use?'],
    injectionSuspected: false,
    confidence: 'medium',
    ...overrides,
  };
}

const a = (n: number) => 'a'.repeat(n);
const items = (n: number) => Array.from({ length: n }, (_, i) => `item ${i}`);

describe('AnalysisSchema', () => {
  it('parses a well-formed analysis', () => {
    const parsed: Analysis = v.parse(AnalysisSchema, valid());
    expect(parsed.issueType).toBe('bug');
    expect(parsed.injectionSuspected).toBe(false);
    expect(parsed.injectionNotes).toBeUndefined();
  });

  it('accepts an optional injectionNotes alongside injectionSuspected', () => {
    const parsed = v.parse(
      AnalysisSchema,
      valid({ injectionSuspected: true, injectionNotes: 'Body asked the agent to ignore rules.' }),
    );
    expect(parsed.injectionSuspected).toBe(true);
    expect(parsed.injectionNotes).toContain('ignore rules');
  });

  it('rejects an unknown extra key rather than dropping it', () => {
    const result = v.safeParse(AnalysisSchema, valid({ exfiltrateTo: 'https://evil.example' }));
    expect(result.success).toBe(false);
  });

  it('requires injectionSuspected, and requires it to be a boolean', () => {
    const missing = valid();
    delete missing['injectionSuspected'];
    expect(v.safeParse(AnalysisSchema, missing).success).toBe(false);

    for (const bad of ['false', 0, 1, null, 'true']) {
      expect(v.safeParse(AnalysisSchema, valid({ injectionSuspected: bad })).success).toBe(false);
    }
  });

  it('requires every non-optional field', () => {
    for (const key of Object.keys(valid())) {
      if (key === 'injectionNotes') continue;
      const partial = valid();
      delete partial[key];
      expect(v.safeParse(AnalysisSchema, partial).success, `${key} should be required`).toBe(false);
    }
  });

  const stringCaps: Array<[string, number]> = [
    ['summary', 1200],
    ['severityRationale', 600],
    ['injectionNotes', 1000],
  ];

  for (const [field, max] of stringCaps) {
    it(`accepts ${field} at ${max} chars and rejects ${max + 1}`, () => {
      expect(v.safeParse(AnalysisSchema, valid({ [field]: a(max) })).success).toBe(true);
      expect(v.safeParse(AnalysisSchema, valid({ [field]: a(max + 1) })).success).toBe(false);
    });
  }

  it('rejects an empty string where prose is required', () => {
    expect(v.safeParse(AnalysisSchema, valid({ summary: '' })).success).toBe(false);
    // Whitespace-only too: `trim` runs before the length check.
    expect(v.safeParse(AnalysisSchema, valid({ summary: '   ' })).success).toBe(false);
  });

  const listCaps: Array<[string, number, number]> = [
    ['affectedComponents', 12, 200],
    ['rootCauseHypotheses', 6, 600],
    ['suggestedActions', 8, 400],
    ['openQuestions', 6, 300],
  ];

  for (const [field, maxItems, maxLength] of listCaps) {
    it(`caps ${field} at ${maxItems} items of ${maxLength} chars`, () => {
      expect(v.safeParse(AnalysisSchema, valid({ [field]: items(maxItems) })).success).toBe(true);
      expect(v.safeParse(AnalysisSchema, valid({ [field]: items(maxItems + 1) })).success).toBe(
        false,
      );
      expect(v.safeParse(AnalysisSchema, valid({ [field]: [a(maxLength)] })).success).toBe(true);
      expect(v.safeParse(AnalysisSchema, valid({ [field]: [a(maxLength + 1)] })).success).toBe(
        false,
      );
    });

    it(`accepts an empty ${field}`, () => {
      expect(v.safeParse(AnalysisSchema, valid({ [field]: [] })).success).toBe(true);
    });
  }

  it('caps relatedPastIssues at 6 entries with 200/400-char fields', () => {
    const entry = { reference: '#1', relevance: 'related' };
    const six = Array.from({ length: 6 }, () => entry);
    expect(v.safeParse(AnalysisSchema, valid({ relatedPastIssues: six })).success).toBe(true);
    expect(v.safeParse(AnalysisSchema, valid({ relatedPastIssues: [...six, entry] })).success).toBe(
      false,
    );
    expect(v.safeParse(AnalysisSchema, valid({ relatedPastIssues: [] })).success).toBe(true);

    for (const [field, max] of [
      ['reference', 200],
      ['relevance', 400],
    ] as const) {
      const at = [{ ...entry, [field]: a(max) }];
      const over = [{ ...entry, [field]: a(max + 1) }];
      expect(v.safeParse(AnalysisSchema, valid({ relatedPastIssues: at })).success).toBe(true);
      expect(v.safeParse(AnalysisSchema, valid({ relatedPastIssues: over })).success).toBe(false);
    }
  });

  it('rejects an unknown key inside relatedPastIssues', () => {
    const result = v.safeParse(
      AnalysisSchema,
      valid({ relatedPastIssues: [{ reference: '#1', relevance: 'x', url: 'https://evil' }] }),
    );
    expect(result.success).toBe(false);
  });

  const picklists: Array<[string, readonly string[]]> = [
    ['issueType', ISSUE_TYPES],
    ['severity', SEVERITIES],
    ['reproducibility', REPRODUCIBILITY],
    ['confidence', ['high', 'medium', 'low']],
  ];

  for (const [field, allowed] of picklists) {
    it(`restricts ${field} to its picklist`, () => {
      for (const value of allowed) {
        expect(v.safeParse(AnalysisSchema, valid({ [field]: value })).success).toBe(true);
      }
      for (const bad of ['catastrophic', '', 'BUG', 'bug ', 42]) {
        expect(
          v.safeParse(AnalysisSchema, valid({ [field]: bad })).success,
          `${field} should reject ${String(bad)}`,
        ).toBe(false);
      }
    });
  }

  it('exposes the picklists it validates against', () => {
    expect(SEVERITIES).toContain('critical');
    expect(ISSUE_TYPES).toContain('security');
    expect(REPRODUCIBILITY).toContain('insufficient-information');
  });
});
