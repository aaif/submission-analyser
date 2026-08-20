import { setProvider } from '@flue/runtime';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { isFaux } from './env.ts';
import { publishDeps } from './tools/analyze-and-publish.ts';

/**
 * Credential-free fake model, for offline verification only.
 *
 * Gated on FLUE_FAUX so importing this module is never enough to swap the real model out —
 * a test-only provider that could activate by accident in CI would be worse than no test at
 * all. Returns the handle when it registered, or null when the flag was absent, so tests can
 * assert the gate itself works.
 */
export function registerFauxProvider(): ReturnType<typeof fauxProvider> | null {
  if (!isFaux()) return null;
  const faux = fauxProvider();
  setProvider(faux.provider);
  return faux;
}

/**
 * The whole offline path in one call, for the agent module and for `npm run agent:faux`:
 * fake model, fake egress, and a scripted happy path. A no-op without FLUE_FAUX.
 */
export function setupFauxRun(): {
  faux: ReturnType<typeof fauxProvider>;
  record: OfflineRecord;
} | null {
  const faux = registerFauxProvider();
  if (faux === null) return null;
  const record = installOfflineDeps();
  scriptScenario(faux, scenarioFromEnv());
  return { faux, record };
}

/**
 * Which scripted run to play. `publish` is the happy path; the other two exist to exercise
 * the `useAgentFinish` guard's two throw branches, which no unit test can reach — plain
 * Vitest cannot import a module that imports SKILL.md, and the agent module does. Without
 * these, the guard's security-relevant behaviour is asserted nowhere.
 */
export type FauxScenario = 'publish' | 'no-tool' | 'rogue-tool';

const SCENARIOS = new Set<FauxScenario>(['publish', 'no-tool', 'rogue-tool']);

export function scenarioFromEnv(): FauxScenario {
  const raw = process.env.FLUE_FAUX_SCENARIO ?? 'publish';
  if (!SCENARIOS.has(raw as FauxScenario)) {
    throw new Error(
      `Unknown FLUE_FAUX_SCENARIO "${raw}". Expected one of: ${[...SCENARIOS].join(', ')}.`,
    );
  }
  return raw as FauxScenario;
}

export function scriptScenario(
  faux: ReturnType<typeof fauxProvider>,
  scenario: FauxScenario,
): void {
  switch (scenario) {
    case 'publish':
      return scriptDefaultRun(faux);
    case 'no-tool':
      return scriptNoToolRun(faux);
    case 'rogue-tool':
      return scriptRogueToolRun(faux);
  }
}

/**
 * The model answers in prose instead of publishing, twice. Expected outcome: the guard
 * appends exactly one nudge, and the second refusal exhausts it and fails the run. This is
 * what proves the framework's 32-cycle continuation ceiling is unreachable — an unbounded
 * nudge loop would be a runaway-cost event that arrives *before* the failure does.
 */
export function scriptNoToolRun(faux: ReturnType<typeof fauxProvider>): void {
  faux.setResponses([
    fauxAssistantMessage('Here is a summary of the issue instead of publishing it.'),
    fauxAssistantMessage('Still just summarising, sorry.'),
  ]);
}

/**
 * The model calls a shell tool rather than the publish tool — the signature of a run taking
 * direction from the issue body. Expected outcome: the guard throws immediately and appends
 * nothing. If this scenario ever *completes*, the detector has stopped detecting.
 */
export function scriptRogueToolRun(faux: ReturnType<typeof fauxProvider>): void {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'echo faux-rogue-scenario' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Done.'),
  ]);
}

/**
 * The default script: call the publish tool once with issue #1, then stop.
 *
 * The `finish` call is what `harness.prompt(..., { result })` requires — the framework
 * injects a `finish` tool and takes its validated arguments as the structured result.
 */
export function scriptDefaultRun(
  faux: ReturnType<typeof fauxProvider>,
  options: { issueNumber?: number; analysis?: Record<string, unknown> } = {},
): void {
  const issueNumber = options.issueNumber ?? 1;
  faux.setResponses([
    // Turn 1, agent conversation: call the one tool.
    fauxAssistantMessage([fauxToolCall('analyze_and_publish', { issueNumber })], {
      stopReason: 'toolUse',
    }),
    // Turn 2, harness scratch conversation: produce the structured analysis.
    fauxAssistantMessage([fauxToolCall('finish', options.analysis ?? SAMPLE_ANALYSIS)], {
      stopReason: 'toolUse',
    }),
    // Turn 3, agent conversation: the tool terminated the turn, so this is a plain reply.
    fauxAssistantMessage('Analysis published.'),
  ]);
}

export const SAMPLE_ANALYSIS = {
  summary: 'The consumer redelivers in-flight jobs after a restart because acks are buffered.',
  issueType: 'bug',
  severity: 'high',
  severityRationale: 'Duplicate delivery corrupts downstream state and we document at-most-once.',
  reproducibility: 'reproducible',
  affectedComponents: ['src/queue/consumer.ts'],
  rootCauseHypotheses: ['The SIGTERM handler exits without flushing the ack buffer.'],
  suggestedActions: ['Await flushAcks() in the shutdown handler with a bounded timeout.'],
  relatedPastIssues: [
    {
      reference: 'example-queue-duplicate-delivery.md',
      relevance: 'Same shutdown-flush mechanism.',
    },
  ],
  openQuestions: ['Does it reproduce without a restart?'],
  injectionSuspected: false,
  confidence: 'medium',
} as const;

/**
 * Replaces the publish tool's side-effect surface with in-memory fakes, so the whole
 * workflow can be exercised with no network and no credentials. Gated on FLUE_FAUX for the
 * same reason as the provider: a fake publisher that could activate in production would
 * report success while doing nothing.
 *
 * Returns a record of what was "published", for assertions.
 */
export interface OfflineRecord {
  docs: Array<{ title: string; markdown: string }>;
  discord: Array<Record<string, unknown>>;
}

export function installOfflineDeps(options: { issue?: Partial<FauxIssue> } = {}): OfflineRecord {
  if (!isFaux()) {
    throw new Error('installOfflineDeps requires FLUE_FAUX=1; refusing to fake a real run.');
  }
  const record: OfflineRecord = { docs: [], discord: [] };
  const issue = { ...SAMPLE_ISSUE, ...options.issue };

  publishDeps.resolveFolderId = () => 'faux-drive-folder';
  publishDeps.fetchIssue = async ({ issueNumber }) => ({ ...issue, number: issueNumber });
  publishDeps.createAnalysisDoc = async ({ title, markdown }) => {
    record.docs.push({ title, markdown });
    return {
      id: 'faux-doc-id',
      url: 'https://docs.google.com/document/d/faux-doc-id/edit',
    };
  };
  publishDeps.postToDiscord = async (input) => {
    record.discord.push({ ...input });
  };
  return record;
}

type FauxIssue = Awaited<ReturnType<typeof publishDeps.fetchIssue>>;

export const SAMPLE_ISSUE: FauxIssue = {
  number: 1,
  title: 'Duplicate webhook deliveries after consumer restart',
  body: 'Restarting the consumer mid-batch redelivers in-flight jobs. Reproduced 3 of 5 runs.',
  url: 'https://github.com/acme/widget/issues/1',
  author: 'octocat',
  authorAssociation: 'NONE',
  isBot: false,
  labels: ['bug', 'queue'],
  state: 'open',
  createdAt: '2026-08-01T00:00:00Z',
  comments: [],
  truncated: false,
};
