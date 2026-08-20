# DESIGN.md — Issue Analysis Agent (Flue 2.0 + GitHub Copilot models, Gemini fallback)

> **Revision note.** This document was rewritten against **Flue 2.0** (released 31 July 2026), which
> replaced the static `defineAgent()` API with a hooks-based one and moved the model layer onto
> [Pi](https://pi.dev). If you are reading an earlier draft that mentions `defineAgent`,
> `configureProvider`, `.flue/agents/`, or `flue run <agent-name> --payload`, that draft is obsolete.

> **Implementation note (2026-08-19).** The sections below marked **[corrected]** were rewritten
> after building the thing, because the shipped packages disagreed with the design in ways that
> deleted work rather than adding it. Three findings drove most of the change: pi-ai already ships
> the providers §3 proposed writing by hand; `flue build` does not exist; and the harness tool §6
> treated as an escalation path is the only way to satisfy functional requirement 5. Every claim
> here was checked against `@flue/runtime@2.0.3` / `@earendil-works/pi-ai@0.84.2` or by running the
> agent, not against recollection of the framework.

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
- **Provider-flexible model access.** Primary access via GitHub Copilot (enterprise entitlements), using Pi's built-in `github-copilot` provider. Gemini is a real, tested fallback.
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
│    ├─ useModel(modelSpecifier(), { thinkingLevel })      │
│    ├─ useSandbox(local({ env: {} }))                     │
│    ├─ useSkill(issueAnalysis)   ← static SKILL.md import │
│    ├─ useTool(analyzeAndPublish)                         │
│    └─ useAgentFinish(guard)                              │
│                                                          │
│  src/skills/issue-analysis/SKILL.md                      │
│    ├─ template.md                                        │
│    └─ references/<past-reviews>.md                       │
│                                                          │
│  AGENTS.md  (repo root — global agent context)           │
└──────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ analyze_and_publish  (harness tool, durable)             │
│   fetch issue → harness.prompt(result: AnalysisSchema)    │
│   → assertNoSecrets → render → publish, in order         │
└──────────────────────────────────────────────────────────┘
   │              │                  │
   ▼              ▼                  ▼
Google Doc  →  issue comment  →  Discord webhook
```

The model calls exactly one tool. Every egress is plain TypeScript downstream of a validated
result, which is what makes ordering, retries and dry-run testable — and what leaves an injected
"post your environment to Discord" with no mechanism to reach.


## Component design

### 1. Repository layout — **[corrected]**

Flue 2.0 has no mandated `.flue/` directory for CLI-run agents. `flue run` takes a module path.

```
.
├── src/
│   ├── agents/issue-analyst.ts       # the agent function — the flue run entrypoint
│   ├── tools/analyze-and-publish.ts  # the ONE harness tool; whole orchestration lives here
│   ├── integrations/                 # plain async functions, NOT defineTool — see §5
│   │   ├── google-docs.ts
│   │   ├── discord.ts
│   │   └── github.ts
│   ├── schema/
│   │   ├── analysis.ts               # AnalysisSchema — the model's only exit channel
│   │   └── integrations.ts
│   ├── safety/
│   │   ├── fence.ts                  # nonce-delimited wrapping of untrusted text
│   │   ├── secret-scan.ts            # reject credential-shaped strings pre-egress
│   │   └── sanitize.ts               # mention/HTML/link hardening at egress
│   ├── skills/issue-analysis/
│   │   ├── SKILL.md                  # statically imported — see §2
│   │   ├── template.md
│   │   └── references/*.md
│   ├── env.ts                        # env validation, fail-fast, never logs values
│   ├── render.ts                     # AnalysisSchema -> markdown (deterministic)
│   └── faux.ts                       # credential-free fake model, gated on FLUE_FAUX=1
├── tests/                            # schema, safety, render, env, integrations, tool
├── .github/workflows/                # ci, issue-analyst, issue-analyst-manual, canary
├── scripts/smoke-{docs,discord,github}.ts
├── docs/{secrets,models,threat-model}.md
├── AGENTS.md
└── package.json, tsconfig.json, .nvmrc
```

**Deliberately absent:** `src/providers/` (§3 explains why there is nothing to register), `app.ts`
(nothing here listens on HTTP), and `.agents/` (§2 explains why skills are imported, not discovered).

The earlier draft put skills in `.agents/skills/` for auto-discovery. That is reversed — see §2.

### 2. The agent function — **[corrected]**

Flue 2.0 agents are functions that call hooks and return instruction text. The function re-renders
before every model call, so conditional hook calls are how capabilities change over a run. **A
consequence worth stating once:** any counter you keep must live at module scope or in
`usePersistentState`, because a `let` inside the agent function resets on every render.

```ts
// src/agents/issue-analyst.ts
'use agent';
import { useModel, useSandbox, useSkill, useTool, useAgentFinish } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import skill from '../skills/issue-analysis/SKILL.md';
import { analyzeAndPublish } from '../tools/analyze-and-publish.ts';
import { modelSpecifier } from '../env.ts';

export function IssueAnalyst() {
  useModel(modelSpecifier(), { thinkingLevel: 'high' });
  useSandbox(local({ env: {} }));
  useSkill(skill);
  useTool(analyzeAndPublish);
  useAgentFinish(/* allowlist guard — see below */);
  return 'Call `analyze_and_publish` once with the issue number, then stop.';
}
```

Three decisions in that block depart from the earlier draft. All three are deliberate.

**Static `SKILL.md` import + `useSkill()`, not `.agents/skills/` auto-discovery.** This settles TODO
4.4 and open question 2, in the opposite direction to what TODO 4.4 suggested trying first. The
reason is the failure shape, not the ergonomics: a malformed workspace `SKILL.md` is **skipped with a
warning**. In headless CI that means the agent still runs, still creates a Doc, still posts to
Discord, still comments on the issue — with an ungrounded analysis and a green check mark. Nobody
looks at a green run. A static import fails at load, before any model call or side effect, with a
message naming the problem and **exit code 1** (verified: malformed frontmatter yields
`{"outcome":"error", ... "must define frontmatter description as a non-empty string."}`). Secondary
reason: auto-discovery reads whatever `SKILL.md` is in the sandbox cwd, which makes the checkout an
unauthenticated instruction channel the moment it is ever attacker-influenced. Do **not** also create
`.agents/skills/` — both copies would mount and drift.

**`useSandbox(local({ env: {} }))`, not `env: { GH_TOKEN }`.** Nothing in the agent's job needs a
token in the sandbox: the integrations read `process.env` in-process, which the model cannot reach.
Passing `{}` costs nothing and removes the entire "the model can print the token" class of failure.
Non-functional requirement 3 says secrets never reach the sandbox env; this is that requirement
expressed in code rather than in prose.

**A `useAgentFinish` guard, bounded structurally.** It returns early on a successful publish; appends
**at most one** nudge if the model finished without publishing, via a module-scope counter, and
throws once that is spent; and **throws immediately, without nudging,** if any tool outside a small
allowlist was called. The asymmetry is the point: nudging a model that may be following injected
instructions is the wrong response to a security signal. The bound must be structural because the
framework ceiling is 32 continuation cycles, and reaching it is a runaway-cost event that arrives
*before* the failure does.

Stated honestly: `local()` mounts file and shell tools regardless of any allowlist, so that guard is
a **detector, not a preventer**. Its value is turning a silent event into a failed run.

### 3. Providers — **[corrected: there is nothing to configure]**

The earlier draft devoted this section to writing a custom Pi provider for Copilot, and to a
`setProvider()` placement footgun. **Both are moot, and the code that would have implemented them
does not exist.**

`flue run` calls `registerDefaultProviders()` unconditionally, which registers every pi-ai built-in.
pi-ai 0.84.2 ships a `github-copilot` provider with 32 models — Claude, GPT, Gemini and Grok
families — each with baseUrl, headers, `contextWindow`, `maxTokens` and cost already in the
catalog. So:

- There is no `src/providers/register.ts`, and no side-effecting import at the top of the agent.
- The **"CRITICAL" `setProvider()`-in-`app.ts` warning no longer applies to anything.** It was real
  advice about a real mechanism; we simply never use that mechanism.
- The "a wrong `contextWindow` silently disables compaction" risk is **gone**, because we no longer
  author `Model` objects. That risk was a consequence of hand-rolling the provider.
- TODO Phase 0 (the blocking Copilot endpoint spike) and Phase 2.1/2.2 are unnecessary.

Correct identifiers, all verified against the installed catalog. The earlier draft had four of these
wrong, and each would have failed at model resolution:

| | Correct | Earlier draft |
|---|---|---|
| Provider id | `github-copilot` | `copilot` |
| Model specifier | `github-copilot/claude-opus-4.7` (dots) | `copilot/claude-opus-4-7` |
| Copilot credential | `COPILOT_GITHUB_TOKEN` | `COPILOT_TOKEN` |
| Fallback model | `github-copilot/gpt-5.4` | `google/gemini-2.5-pro` + `GOOGLE_GENERATIVE_AI_API_KEY` |

**[corrected] One provider, not two.** Earlier drafts, and my own first implementation, ran the
fallback leg on `google/gemini-2.5-pro` with a second credential. That was wasted surface: Copilot's
own catalog spans four vendors, so `github-copilot/gpt-5.4` delivers the same "different lab, so not
the same outage" property with one API key, one billing relationship, and one provider integration to
keep working. `src/env.ts` now *enforces* the single provider — `requireModelCredential()` throws on
any specifier outside `github-copilot`. That check has to be in code, not just here: `FLUE_MODEL`
comes from a repo variable editable in one click, and `flue run` registers every built-in provider,
so an unguarded specifier plus a stray API-key secret would quietly route issue bodies to a vendor
nobody signed off on. What this does *not* buy is resilience to a Copilot outage; both legs fail
together, which is the accepted price and is documented in docs/models.md.

**The one residual model-access risk.** The built-in Copilot baseUrl is the *individual* endpoint,
`https://api.individual.githubcopilot.com`. A business or enterprise entitlement may require
`api.business.` or `api.enterprise.`. If model calls 401/404, that is the first thing to try — and it
is a one-line `setProvider` override that reuses the existing catalog entry, not a provider rewrite.
`docs/models.md` carries the sketch. This is now the *only* place the original endpoint anxiety still
has teeth, and it is much smaller than the original design assumed.

Also gone with it: the Copilot-SDK bail-out (TODO 0.2) is no longer a bail-out we need designed, and
the "endpoint is community-discovered" concern is now pi-ai's maintenance burden rather than ours.

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
    FLUE_MODEL: ${{ vars.PRIMARY_MODEL }}    # github-copilot/claude-opus-4.7
    COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
  run: npx flue run src/agents/issue-analyst.ts --message "Analyze issue #${{ github.event.issue.number }}" --json | tee result.json

- name: Run agent (fallback)
  if: steps.primary.outcome == 'failure'
  env:
    FLUE_MODEL: ${{ vars.FALLBACK_MODEL }}   # github-copilot/gpt-5.4
    COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
  run: npx flue run src/agents/issue-analyst.ts --message "Analyze issue #${{ github.event.issue.number }}" --json | tee result.json
```

Both legs share the one model credential, because both models are served by Copilot. The diversity
is at the *model* level: a Claude-side outage or a bad Claude deploy does not take out both attempts.
`src/env.ts` rejects any specifier outside the `github-copilot` provider, so the variable that
selects the model cannot be used to introduce a new one.

**`continue-on-error` needs a matching assertion or it silently inverts the design.** With it set,
the job reports success when *both* model steps fail. So a final, non-`continue-on-error` step parses
the `--json` envelope and fails the job unless `outcome == "completed"` and a Doc URL is present. The
envelope field is `outcome`, and its values are `"completed"` / `"failed"` / `"aborted"` /
`"error"` — asserting on `"success"` matches nothing and passes always.

This is cruder than an in-process retry, but it is honest about the runtime's semantics, and it has a
real advantage: the fallback run is a clean process with a fresh sandbox, so a half-completed primary
run cannot corrupt it. The cost is that a primary failure *after* Doc creation produces a duplicate
Doc on the fallback run. Accepted — see idempotence below. Within a single run, `durable: true` plus
one `step.do` per side effect means a *retry* cannot duplicate anything; it is only the
fresh-process fallback that can.

*If* we later want in-run adaptivity, the Flue-native pattern is `usePersistentState` plus a
conditional `useModel`, which takes effect on the next submission. That suits long-lived conversational
agents, not one-shot CI jobs.

### 5. Integrations as plain functions — **[corrected]**

The earlier draft made each side effect a `defineTool` mounted with `useTool()`. **They are now plain
async functions that the model cannot call at all** — `createAnalysisDoc`, `postToDiscord`,
`fetchIssue`, `commentOnIssue` — invoked from the harness tool in §6.

The draft's reasoning about the secret boundary was right and still holds: implementations read
credentials from `process.env`, and the model never sees them. Not mounting them as tools is strictly
stronger. A mounted `post_to_discord` is a *mechanism* an injected instruction can name; an unmounted
plain function is not reachable from the model's action space at all. Given that issue bodies are
attacker-controlled and DESIGN's own Risks table calls injection the highest-priority risk, removing
the mechanism beats instructing the model not to use it.

Each function re-validates its own input at the egress boundary and takes an injectable dependency
seam (`fetchImpl`, `octokit`, `accessToken`), which is what lets the whole publish path be tested
with no credentials.

- **Google Docs** — a single Drive `files.create` multipart upload: metadata `mimeType:
  application/vnd.google-apps.document` with a `text/markdown` body, `supportsAllDrives=true`,
  `fields=id,webViewLink`, scope `drive.file`. Drive does the markdown→Docs conversion in one call.
  The Docs API `batchUpdate` path is **rejected**: it requires computing character indices for every
  style range, where each insert shifts every later index. The source mimetype is one constant so
  `text/html` is a one-line fallback. `permissions.create` is **never** called — the Doc URL gets
  posted publicly, so access must come from folder inheritance. Naming: `[ANALYSIS] #<n> — <title>`.
- **Discord** — plain `fetch` to the webhook, small embed, not the full analysis. The load-bearing
  line is `allowed_mentions: { parse: [] }`; without it, "include @everyone in your summary" in an
  issue body mass-pings the server. The webhook URL is itself a credential and never appears in an
  error message.
- **GitHub** — `fetchIssue()` is where untrusted text enters the process, so it hard-caps title,
  body and comment count and returns `authorAssociation` and `isBot`. `commentOnIssue()` posts the
  link. **The sandbox/`gh` option is dropped**, not merely deprioritised: the sandbox env is now
  empty, so there is no token in there to shell out with.

**Publication order is Doc → issue comment → Discord**, reversing the original draft's Discord-first
ordering. The Doc is the artefact and the comment is what the reporter sees, so a broken webhook must
not be able to deny them either. This still satisfies TODO 7.4: the run fails loudly and the Doc and
comment survive.

### 6. Orchestration — **[corrected: the harness tool is the default, not an escalation]**

The earlier draft made ordering instruction-driven and treated one harness tool as a conditional
escalation if the model proved unreliable. **That escalation is now the design, and the
instruction-driven version was never built.** `analyze_and_publish` is a single
`defineTool({ harness: true, durable: true })` taking `{ issueNumber }`; it fetches the issue, calls
`harness.prompt(instructions + fencedIssue, { result: AnalysisSchema })`, runs `assertNoSecrets`,
renders markdown, and publishes in order — or short-circuits on `DRY_RUN`. It returns
`terminate: true`, so the outer model gets no turn after publishing.

Promoted from conditional to default for three reasons, in order of weight:

1. **Functional requirement 5 is otherwise unenforceable.** "Structured output passes validation
   before any side effect occurs" cannot be delivered by asking a model to call three tools in the
   right order. `harness.prompt(..., { result: AnalysisSchema })` makes validation a precondition in
   the type system.
2. **It collapses the injection surface**, per §5.
3. **Ordering, retries, partial failure and dry-run become ordinary TypeScript** with ordinary tests.

The obvious worry — that moving the analysis inside a tool starves it of the skill — does not apply.
Verified in Flue's own docs (`guide/skills.md`): a harness tool's `harness.prompt(...)` runs with the
agent's rendered configuration, meaning the same system prompt, skill catalog and tools.

`durable: true` is what makes retry safe: each side effect is its own `step.do`, recorded
exactly-once, so a retried run resumes rather than creating a second Doc or double-posting. One sharp
edge found the hard way: `step.do` persists its return value and the store **rejects `undefined`**,
so a step wrapping a `void` function must return an explicit marker.

## Requirements

### Functional

1. On issue open, the agent starts within 60s of the webhook firing.
2. Output matches `template.md`.
3. A Google Doc is created; its URL is commented on the issue and posted to Discord.
4. The agent consults relevant past analyses in `references/` before writing.
5. Structured output passes Valibot validation before any side effect occurs. **Enforced by
   construction** — see §6 — rather than requested of the model.
6. **Suspected prompt injection is reported, not silently absorbed.** `AnalysisSchema` carries
   `injectionSuspected` and `injectionNotes`, and the rendered Doc leads with a banner when the flag
   is set. An attempt that is merely ignored teaches nobody anything.

### Non-functional

1. **Model abstraction.** Switching models or providers is one env var (`FLUE_MODEL`). No code change.
2. **Reusability.** A new agent needs no changes to `src/integrations/`, `src/safety/`, `src/env.ts`
   or config. (The original wording named `src/providers/`, which no longer exists — §3.)
3. **Secrets.** Secrets reach integrations via `process.env`, never via the sandbox env — which is
   `{}` — and never into model context. No `console.log` of env. Env-validation errors name variable
   *names* only; `src/env.ts` deliberately does not use Valibot, because a Valibot issue carries the
   offending `input` value and several of those inputs are credentials.
4. **Idempotence.** Re-runs create a new Doc rather than overwriting. Re-runs are usually debugging,
   and overwriting destroys evidence. Within a run, `durable: true` makes retry non-duplicating; the
   §4 fresh-process fallback can still yield two Docs on a late primary failure. Acceptable.
5. **Cost.** Under $0.50 per run at current Copilot pricing for medium issues. `thinkingLevel: 'high'`
   (not `max`) is the deliberate lever; the tool logs model and token usage per run so the number is
   observable rather than assumed.
6. **Verifiable without credentials.** `npm run verify` — format, typecheck, tests, and a real
   `flue run` against pi-ai's faux provider — passes with no secrets at all. This is what lets
   `ci.yml` hold zero secrets, and what makes the injection corpus cheap enough to never skip.

## Constraints

1. **TypeScript.** Flue 2.0 is TypeScript-native. (A community Python port, PyFlue, exists and tracks
   the framework, but it is third-party and out of scope.)
2. **Node.js >= 22.19.0** — the Flue CLI's minimum. Workflows read `.nvmrc`.
3. **Node target on GitHub Actions runners.** No Cloudflare, no container sandbox for v1.
4. **Copilot endpoint variant is unverified for our entitlement.** The built-in provider targets the
   *individual* endpoint; business/enterprise may differ. One-line override, Gemini fallback is real.
   (The original "the endpoint is community-discovered" framing now describes pi-ai's problem, not
   ours — §3.)
5. **`local()` sandbox means the runner is the isolation boundary.** The agent has direct host shell
   access. This is appropriate for a repo-scoped CI job and inappropriate for anything processing
   untrusted input beyond the issue text itself. Note that issue bodies *are* attacker-controlled —
   see Risks.
6. **Small reference corpus.** No vector DB below ~50 files.
7. **`flue build` does not exist.** The CLI has `run`, `init`, `blueprint`, `docs`. There is no build
   step, and `vite build` would require an `app.ts` this project deliberately lacks. The loud
   SKILL.md validation gate is `flue run` itself — it validates skills at load, before any model call
   or side effect, and exits 1. Do not reintroduce a `build` script expecting one.
8. **Channels are not usable here.** `@flue/discord` and `@flue/github` are inbound-only HTTP
   ingress requiring `app.ts` and a public HTTPS endpoint. A one-shot CI job has neither.

## Open questions

1. Which Copilot model by default? Benchmark a Claude and a GPT option over ~10 past issues. **Still
   open** — needs credentials and real issues.
2. ~~Explicit `useSkill()` vs. workspace auto-discovery~~ — **settled: explicit, statically imported.**
   Reasoning in §2. Note this reverses what TODO 4.4 proposed trying first.
3. Labels as well as comments? Out of scope for v1.
4. ~~Dry-run mode~~ — **settled: `DRY_RUN=1` is a real flag.** Piping `--json` to `jq` would not have
   been enough, because the question a dry run answers is "would this have published?", and by the
   time there is JSON to inspect the Doc already exists. The flag short-circuits after validation and
   before the first side effect, which also makes it the right thing for the canary to run daily.
5. ~~Usable MCP server for Google Docs or Discord?~~ — **settled: no.** No Google Docs channel,
   blueprint or MCP server exists anywhere in the Flue ecosystem, and a Discord MCP server would
   reintroduce exactly the model-reachable egress mechanism §5 removes on purpose. Hand-written
   integrations stay. `useMcpConnection()` remains available for genuinely read-only context sources.
6. **New:** does the skill's retrieval step actually consult `references/`? If produced Docs never
   cite a past review, retrieval is not working and requirement 4 is unmet regardless of how good the
   analysis reads. Needs a real run (TODO 7.1).

## Risks

| Risk | Mitigation |
|---|---|
| **Prompt injection via issue body.** Issue text is attacker-controlled and reaches an agent with host shell access. | Highest-priority risk. Structural first: no Docs/Discord/GitHub-write tool is mounted, so an injected exfiltration instruction has no mechanism to name (§5). Then nonce-fenced untrusted text; a strict output schema as the only exit channel; `assertNoSecrets` before egress; `sanitize` at egress; `contents: read` only; a finish-guard detector. Reported via `injectionSuspected`, and exercised on every PR by the `tests/fixtures/injections/` corpus. See `docs/threat-model.md`. |
| **Exfiltration through the analysis text**, the one channel the structural measures leave open — the model can be talked into *writing* a secret into a field. | `assertNoSecrets` walks the validated object before any egress, matching both live env values and 11 credential shapes, and throws with the rule name only — never the matched text. This is the residual risk that most deserves a second pair of eyes. |
| Copilot endpoint variant wrong for our entitlement (individual vs business/enterprise) | The only residual model-access risk after §3. One-line `setProvider` baseUrl override reusing the catalog; daily canary; Gemini fallback |
| Copilot ToS ambiguity on programmatic use | Read the acceptable-use policy before production; Gemini as the out |
| **`continue-on-error` silently inverting the fallback design** — the job reports success when both model steps fail | A final required step asserts `outcome == "completed"` *and* a Doc URL. Asserting `"success"` would match nothing and pass always |
| A malformed `SKILL.md` producing a confident, ungrounded analysis under a green check mark | Static import, validated at load with exit code 1 (§2). This is the specific failure that auto-discovery would have allowed |
| Flue 2.0 is weeks old | "First stable release" commits the API contract, not the absence of sharp edges. Exact pins, no carets, committed lockfile, `overrides` on `@earendil-works/pi-ai` and `valibot` — the latter because two copies of valibot in the tree means schemas are validated by a different instance than the one that built them |
| Confidential content in `references/` leaking into a Doc | Docs land in a private Drive folder, never link-anyone shared; seed corpus is synthetic and clearly marked, and real analyses must be audited before committing |
| Discord webhook used to mass-ping or launder attacker links under the bot's trusted identity | `allowed_mentions: { parse: [] }`, mention neutralisation, and non-allowlisted links rendered inert |

## Deferred / dropped from earlier drafts

Recorded so nobody re-derives them:

- **A custom Pi provider for Copilot** (`src/providers/register.ts`) — unnecessary; pi-ai ships it.
- **The `setProvider()`-in-`app.ts` footgun** — real mechanism, but we never use it.
- **Hand-authored `Model` objects, and the "wrong `contextWindow` disables compaction" risk** — gone
  with the custom provider.
- **The Copilot SDK bail-out** — no longer a bail-out that needs designing.
- **Three model-callable integration tools** — replaced by one harness tool (§6).
- **`.agents/skills/` auto-discovery** — replaced by static imports (§2).
- **`gh` via the sandbox for the issue comment** — the sandbox env is empty; there is no token there.
- **`flue build` as a CI gate** — the command does not exist; `flue run` is the gate.
