# DESIGN.md — Issue Analysis Agent (Flue 2.0 + GitHub Copilot models, Gemini fallback)

> **Revision note.** This document was rewritten against **Flue 2.0** (released 31 July 2026), which
> replaced the static `defineAgent()` API with a hooks-based one and moved the model layer onto
> [Pi](https://pi.dev). If you are reading an earlier draft that mentions `defineAgent`,
> `configureProvider`, `.flue/agents/`, or `flue run <agent-name> --payload`, that draft is obsolete.

## Purpose

An agent, run as a GitHub Action, that responds to newly filed issues by:

1. Analyzing the issue against repository context and prior hand-written reviews.
2. Writing the analysis to a Google Doc.
3. Posting the Doc link to a Discord channel.
4. Commenting on the originating issue with the link.

This is the first user of a reusable Flue scaffold we expect to extend with more agents.

## Goals

- **Repeatable analysis.** Encode the pattern as a Flue skill, mounted with `useSkill()`, so it runs identically across issues with no per-issue prompt engineering.
- **Context-grounded, cheaply.** Past analyses and the output template are skill assets. Flue's skills are progressively disclosed — each mounted skill costs one catalog line in the system prompt, and full instructions arrive only when the model calls `activate_skill`. Supporting files stay unread until the model reads them. We do not pay context for reviews the agent doesn't consult.
- **Provider-flexible model access.** Primary access via GitHub Copilot (enterprise entitlements), registered as a custom Pi provider. Gemini is a real, tested fallback.
- **Reusable scaffold.** New agents = new agent function + new skill folder + new workflow file.
- **Auditable.** Every run produces a Doc with a deterministic name and logs which model answered.

## Non-goals

- No human-in-the-loop UI; the agent runs headlessly in CI.
- No autonomous remediation. This agent analyzes and reports. It does not modify code or open PRs. (Flue supports this — the docs' own auto-triage example does it — but it is out of scope for v1.)
- No real-time Discord interaction. Posting is fire-and-forget.
- No vector store. Past reviews are files in the skill folder.
- No deployed HTTP server. This agent is CLI-invoked only.

## Architecture

```
Issue opened
   │
   ▼
.github/workflows/issue-analyst.yml
   │  npx flue run src/agents/issue-analyst.ts --message "Analyze issue #123" --json
   ▼
┌──────────────────────────────────────────────────────────┐
│ Flue runtime (in-process, no HTTP listener)              │
│                                                          │
│  src/agents/issue-analyst.ts                             │
│    ├─ import '../providers/register'   ← MUST be here    │
│    ├─ useModel(env.PRIMARY_MODEL)                        │
│    ├─ useSandbox(local({ env: { GH_TOKEN } }))           │
│    ├─ useSkill(issueAnalysis)                            │
│    └─ useTool(createAnalysisDoc / postToDiscord / …)     │
│                                                          │
│  .agents/skills/issue-analysis/SKILL.md                  │
│    ├─ template.md                                        │
│    └─ references/<past-reviews>.md                       │
│                                                          │
│  AGENTS.md  (repo root — global agent context)           │
└──────────────────────────────────────────────────────────┘
   │              │                  │
   ▼              ▼                  ▼
Google Docs   Discord webhook   GitHub API
```

## Component design

### 1. Repository layout

Flue 2.0 has no mandated `.flue/` directory for CLI-run agents. `flue run` takes a module path.

```
.
├── src/
│   ├── agents/
│   │   └── issue-analyst.ts        # the agent function
│   ├── providers/
│   │   └── register.ts             # setProvider() calls — see §3
│   └── tools/
│       ├── google-docs.ts          # defineTool: create the Doc
│       ├── discord.ts              # defineTool: post the link
│       └── github.ts               # defineTool: comment on the issue
├── .agents/
│   └── skills/
│       └── issue-analysis/
│           ├── SKILL.md            # frontmatter: name, description
│           ├── template.md
│           └── references/
│               └── 2025-11-15-auth-bug.md
├── .github/workflows/
│   ├── issue-analyst.yml
│   └── issue-analyst-manual.yml
├── AGENTS.md
├── DESIGN.md
├── TODO.md
├── package.json
└── tsconfig.json
```

Skills live in `.agents/skills/` — this is the convention Flue discovers automatically from the
sandbox workspace. `AGENTS.md` at the project root supplies global context.

### 2. The agent function

Flue 2.0 agents are functions that call hooks and return instruction text. The function re-renders
before every model call, so conditional hook calls are how capabilities change over a run.

```ts
// src/agents/issue-analyst.ts
import '../providers/register';           // side-effecting: registers Copilot + Gemini
import { useModel, useSandbox, useSkill, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { createAnalysisDoc } from '../tools/google-docs';
import { postToDiscord } from '../tools/discord';
import { commentOnIssue } from '../tools/github';

export function IssueAnalyst() {
  useModel(process.env.FLUE_MODEL!, { thinkingLevel: 'high' });
  useSandbox(local({ env: { GH_TOKEN: process.env.GH_TOKEN } }));
  useTool(createAnalysisDoc);
  useTool(postToDiscord);
  useTool(commentOnIssue);
  return [
    'You analyze newly filed GitHub issues.',
    'Given an issue number: apply the `issue-analysis` skill, then call',
    '`create_analysis_doc`, then `post_to_discord`, then `comment_on_issue`, in that order.',
    'Do not skip steps. Do not modify code.',
  ].join('\n');
}
```

Note `useSkill` is absent above on purpose: with `local()`, skills in `.agents/skills/` are
discovered from the workspace automatically. Use explicit `useSkill()` only for skills imported from
npm or defined in code. Decide this in Phase 4 and keep it consistent.

### 3. Provider configuration — **and the gotcha that will bite you**

Flue's model layer is Pi's provider protocol. Providers register via `setProvider()`, and custom
endpoints are built with Pi's `createProvider()`.

> **CRITICAL:** `flue run` loads **only the agent module** — it never loads `app.ts`. A
> `setProvider()` call placed in `app.ts` will silently not register, and the run will fail at model
> resolution with an unknown-provider error. Because our entire deployment model is `flue run` in CI,
> the registration **must** live in a module the agent imports. Hence `src/providers/register.ts`,
> imported at the top of the agent module for its side effect.

```ts
// src/providers/register.ts
import { setProvider } from '@flue/runtime';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

setProvider(createProvider({
  id: 'copilot',
  auth: { apiKey: { name: 'GitHub Copilot', resolve: async () => ({ auth: { apiKey: process.env.COPILOT_TOKEN! } }) } },
  models: [ /* Model objects; each carries its own baseUrl + headers + contextWindow */ ],
  api: openAICompletionsApi(),
}));
```

Two consequences of Pi's model:

- **Model metadata is ours to declare.** Each `Model` object carries its own `baseUrl`, headers,
  `contextWindow`, and cost. Getting `contextWindow` right matters: it is what lets threshold
  compaction engage. A wrong or zero value means compaction cannot trigger.
- **Registration performs no I/O.** A bad endpoint or key surfaces as a provider error on the first
  model request, not at registration. Phase 0's spike is how we find out early.

**Gemini** is registered the same way (or via the built-in `google` provider with
`GOOGLE_GENERATIVE_AI_API_KEY`, if its catalog covers the model we want — confirm in Phase 0.3).

**Copilot endpoint caveat, unchanged from the original design:** the Copilot chat-completions
endpoint is not officially documented for third-party programmatic use. Community providers drive the
pattern. Headers and integration IDs may shift. Phase 0.1 validates it; Phase 0.2 is the bail-out to
the official Copilot SDK behind a custom Pi provider.

### 4. Fallback strategy — **changed from the original design**

The original design proposed a `withFallback()` wrapper around each model call. **That does not map
onto Flue 2.0.** `useModel()` values are *submission-scoped*: the runtime reads them once when a
submission starts, so a different model computed by a later render takes effect on the next
submission, not mid-run. A one-shot CI run is a single submission. There is no in-run swap.

So fallback moves up a level, to the workflow:

```yaml
- name: Run agent (primary)
  id: primary
  continue-on-error: true
  env:
    FLUE_MODEL: ${{ vars.PRIMARY_MODEL }}   # e.g. copilot/claude-opus-4-7
  run: npx flue run src/agents/issue-analyst.ts --message "Analyze issue #${{ github.event.issue.number }}" --json

- name: Run agent (fallback)
  if: steps.primary.outcome == 'failure'
  env:
    FLUE_MODEL: ${{ vars.FALLBACK_MODEL }}  # e.g. google/gemini-2.5-pro
  run: npx flue run src/agents/issue-analyst.ts --message "Analyze issue #${{ github.event.issue.number }}" --json
```

This is cruder than an in-process retry, but it is honest about the runtime's semantics, and it has a
real advantage: the fallback run is a clean process with a fresh sandbox, so a half-completed primary
run cannot corrupt it. The cost is that a primary failure *after* Doc creation produces a duplicate
Doc on the fallback run. Accepted — see idempotence below.

*If* we later want in-run adaptivity, the Flue-native pattern is `usePersistentState` plus a
conditional `useModel`, which takes effect on the next submission. That suits long-lived conversational
agents, not one-shot CI jobs.

### 5. Integrations as tools

Each side effect is a `defineTool` with a Valibot input schema, mounted with `useTool()`. This gives
us the **tight secret boundary** the Flue docs recommend: the tool implementation reads the secret
from `process.env`, and the model only ever sees the tool's parameters and result. The Discord webhook
URL, Google service-account JSON, and GitHub token never enter the model's context.

This is a deliberate choice over letting the agent shell out via `local()`'s bash tool. Bash access
is available (and useful for `gh issue view`), but a secret forwarded into the sandbox env is a secret
the model can print.

- **Google Docs** — service account with Editor on a designated Drive folder. Naming convention:
  `[ANALYSIS] #<issue-number> — <truncated-title>`.
- **Discord** — webhook URL as a secret. Posts a small embed (title, link, one-line summary), not the
  full analysis.
- **GitHub** — `gh` is on the runner's `$PATH` and `GITHUB_TOKEN` is provided automatically, so the
  issue comment can go through either a tool or the sandbox. Prefer the tool, for the boundary above.

### 6. Orchestration

For v1 the ordering is instruction-driven (the agent is told to call the three tools in sequence).
If that proves unreliable, promote it to a single harness tool — `useTool({ harness: true })` whose
`run` calls `harness.prompt(..., { result: schema })` and then invokes the integrations in plain
TypeScript. That is the documented pattern for deterministic multi-step work and removes the model's
discretion over ordering entirely. Treat this as the known escalation path, not a rewrite.

## Requirements

### Functional

1. On issue open, the agent starts within 60s of the webhook firing.
2. Output matches `template.md`.
3. A Google Doc is created; its URL is posted to Discord and commented on the issue.
4. The agent consults relevant past analyses in `references/` before writing.
5. Structured output passes Valibot validation before any side effect occurs.

### Non-functional

1. **Model abstraction.** Switching models or providers is one env var (`FLUE_MODEL`). No code change.
2. **Reusability.** A new agent needs no changes to `src/providers/`, `src/tools/`, or config.
3. **Secrets.** Secrets reach tools via `process.env`, never via the sandbox env and never into model
   context. No `console.log` of env.
4. **Idempotence.** Re-runs create a new Doc rather than overwriting. Re-runs are usually debugging,
   and overwriting destroys evidence. Note this interacts with §4's fallback: a late primary failure
   can yield two Docs. Acceptable; revisit if it becomes noisy.
5. **Cost.** Under $0.50 per run at current Copilot pricing for medium issues. `thinkingLevel` and
   `contextWindow` are the levers.

## Constraints

1. **TypeScript.** Flue 2.0 is TypeScript-native. (A community Python port, PyFlue, exists and tracks
   the framework, but it is third-party and out of scope.)
2. **Node.js >= 22.19.0** — the Flue CLI's minimum. Pin `node-version: 22` in the workflow.
3. **Node target on GitHub Actions runners.** No Cloudflare, no container sandbox for v1.
4. **Copilot endpoint is community-discovered.** Accepted risk; Gemini fallback is real.
5. **`local()` sandbox means the runner is the isolation boundary.** The agent has direct host shell
   access. This is appropriate for a repo-scoped CI job and inappropriate for anything processing
   untrusted input beyond the issue text itself. Note that issue bodies *are* attacker-controlled —
   see Risks.
6. **Small reference corpus.** No vector DB below ~50 files.

## Open questions

1. Which Copilot model by default? Benchmark a Claude and a GPT option over ~10 past issues.
2. Explicit `useSkill()` vs. workspace auto-discovery — pick one in Phase 4.
3. Labels as well as comments? Out of scope for v1.
4. Dry-run mode: `flue run --json` piped to `jq` may be enough without building a flag.
5. Is there a usable MCP server for Google Docs or Discord? `useMcpConnection()` is built in, and
   connections can be marked `optional` so a flaky server degrades instead of failing the run. Could
   replace hand-written tools — but loses the secret boundary from §5. Evaluate, don't assume.

## Risks

| Risk | Mitigation |
|---|---|
| **Prompt injection via issue body.** Issue text is attacker-controlled and reaches an agent with host shell access and write-capable tools. | Highest-priority risk. Instruct the agent to treat issue content as data, not instruction. Keep tools narrowly scoped with strict input schemas. Consider `useAgentFinish` to assert the response only called expected tools. Do not grant `contents: write`. |
| `setProvider()` in the wrong module (`app.ts`) | Documented in §3; Phase 2 task asserts it via a test run of `flue run` |
| Copilot endpoint headers change | Pin a known-good integration ID; scheduled daily canary run; alert on failure |
| Copilot ToS ambiguity on programmatic use | Read the acceptable-use policy before production; Copilot SDK or Gemini as the out |
| Wrong `contextWindow` in a custom Model object disables compaction | Verify against the provider's real limit in Phase 0; assert in the canary |
| Flue 2.0 is three weeks old | "First stable release" commits the API contract, not the absence of sharp edges. Pin exact versions; read release notes before bumping |
| Confidential content in `references/` leaking into a Doc | Docs land in a private Drive folder; audit the seed corpus in Phase 4 |
