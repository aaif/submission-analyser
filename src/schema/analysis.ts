import * as v from 'valibot';

/**
 * The analysis schema. This is the model's ONLY exit channel: the publish tool passes it
 * to `harness.prompt(..., { result: AnalysisSchema })`, so the model must produce a value
 * that validates before any side effect can run. Every string and array is bounded —
 * unbounded fields are both a cost and a denial-of-service surface, and a validated-but
 * -enormous field would sail into a Doc, a Discord embed, and an issue comment.
 *
 * `strictObject` (not `object`) so an unexpected extra key is a hard failure rather than
 * silently discarded data.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export const ISSUE_TYPES = [
  'bug',
  'feature-request',
  'documentation',
  'question',
  'security',
  'ambiguous',
] as const;
export const REPRODUCIBILITY = [
  'reproducible',
  'not-reproducible',
  'insufficient-information',
  'not-applicable',
] as const;

const shortText = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));

const bulletList = (maxItems: number, maxLength: number) =>
  v.pipe(v.array(shortText(maxLength)), v.maxLength(maxItems));

export const RelatedReferenceSchema = v.strictObject({
  /** A `references/` filename, or an issue reference like `#412`. */
  reference: shortText(200),
  relevance: shortText(400),
});

export const AnalysisSchema = v.strictObject({
  /** One-paragraph restatement of the issue in the maintainers' terms. */
  summary: shortText(1200),
  issueType: v.picklist(ISSUE_TYPES),
  severity: v.picklist(SEVERITIES),
  severityRationale: shortText(600),
  reproducibility: v.picklist(REPRODUCIBILITY),
  affectedComponents: bulletList(12, 200),
  rootCauseHypotheses: bulletList(6, 600),
  suggestedActions: bulletList(8, 400),
  /** Grounding in the seed corpus. Empty is legitimate — a genuinely novel issue. */
  relatedPastIssues: v.pipe(v.array(RelatedReferenceSchema), v.maxLength(6)),
  /** Questions to put back to the reporter when the issue is under-specified. */
  openQuestions: bulletList(6, 300),
  /**
   * Set when the issue text tried to steer the agent rather than describe a problem.
   * Modelled as a reported finding rather than an exception: an injection attempt is
   * useful signal for maintainers, and giving the model a sanctioned way to say
   * "someone tried this" is more reliable than hoping it silently declines.
   */
  injectionSuspected: v.boolean(),
  injectionNotes: v.optional(shortText(1000)),
  /** The model's own confidence, surfaced so a low-confidence analysis reads as one. */
  confidence: v.picklist(['high', 'medium', 'low'] as const),
});

export type Analysis = v.InferOutput<typeof AnalysisSchema>;
export type Severity = (typeof SEVERITIES)[number];
