/**
 * A hand-rolled `ToolContext` for driving `analyzeAndPublish.run(...)` directly.
 *
 * The real context comes from the Flue runtime, which needs an agent session, a sandbox and a
 * model. None of that is needed to test the tool's own logic: the tool only touches
 * `data`, `harness.prompt`, `step.do` and `log`. So this supplies exactly those four, records
 * everything they receive, and is cast to the runtime type at the boundary — the cast is the
 * one place the fake meets the real signature, rather than being spread through the tests.
 */

import type { Analysis } from '../../src/schema/analysis.ts';
import { analyzeAndPublish } from '../../src/tools/analyze-and-publish.ts';

export type ToolRunContext = Parameters<typeof analyzeAndPublish.run>[0];

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  attributes: Record<string, unknown> | undefined;
}

export interface PromptCall {
  text: string;
  hasResultSchema: boolean;
}

export interface StubContext {
  ctx: ToolRunContext;
  /** `step.do` names, in the order they were entered. */
  steps: string[];
  /** `step.do` names whose function resolved, in completion order. */
  completedSteps: string[];
  logs: LogLine[];
  prompts: PromptCall[];
}

export interface StubContextOptions {
  issueNumber?: number;
  /** What `harness.prompt(..., { result })` resolves its `data` to. */
  analysis?: unknown;
  /** Or throw instead. */
  promptError?: Error;
  model?: { provider: string; id: string };
  totalTokens?: number;
  costTotal?: number;
}

export function makeToolContext(options: StubContextOptions = {}): StubContext {
  const steps: string[] = [];
  const completedSteps: string[] = [];
  const logs: LogLine[] = [];
  const prompts: PromptCall[] = [];

  const step = {
    async do<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      steps.push(name);
      const value = await fn();
      completedSteps.push(name);
      return value;
    },
  };

  const log = {
    info(message: string, attributes?: Record<string, unknown>) {
      logs.push({ level: 'info', message, attributes });
    },
    warn(message: string, attributes?: Record<string, unknown>) {
      logs.push({ level: 'warn', message, attributes });
    },
    error(message: string, attributes?: Record<string, unknown>) {
      logs.push({ level: 'error', message, attributes });
    },
  };

  const usage = {
    input: 1000,
    output: 200,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: options.totalTokens ?? 1200,
    cost: {
      input: 0.001,
      output: 0.002,
      cacheRead: 0,
      cacheWrite: 0,
      total: options.costTotal ?? 0.0123456,
    },
  };

  const harness = {
    name: 'test-harness',
    prompt(text: string, promptOptions?: { result?: unknown }) {
      prompts.push({ text, hasResultSchema: promptOptions?.result !== undefined });
      if (options.promptError) return Promise.reject(options.promptError);
      return Promise.resolve({
        data: options.analysis as Analysis,
        usage,
        model: options.model ?? { provider: 'faux', id: 'faux-1' },
      });
    },
  };

  const ctx = {
    toolCallId: 'test-tool-call-1',
    data: { issueNumber: options.issueNumber ?? 1 },
    harness,
    step,
    log,
  } as unknown as ToolRunContext;

  return { ctx, steps, completedSteps, logs, prompts };
}
