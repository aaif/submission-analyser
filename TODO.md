# TODO.md — Build out the Issue Analysis Agent (Flue 2.0)

Ordered. **[BLOCKER]** must resolve before later work. **[SPIKE]** may change the plan.

> **Status (2026-08-19).** Phases 0–7 have been worked through. Items are marked **[DONE]**,
> **[DROPPED]** with the reason, or **[NEEDS CREDENTIALS]** where the remaining work is a human
> holding a real token. Phase 8 is untouched and still the next thing. Where an item was dropped, the
> reason is recorded inline rather than deleted — the point is that nobody re-derives it.

Read `DESIGN.md` first. Three things in it will save you a day if you internalize them now
(the first has been struck through because it turned out to be a non-problem — kept so the
correction is visible rather than looking like an omission):

- ~~`flue run` loads only the agent module, never `app.ts`. Provider registration must be in a module
  the agent imports.~~ **Moot** — `flue run` calls `registerDefaultProviders()` unconditionally and
  pi-ai already ships `github-copilot` and `google`. Nothing registers anything. See DESIGN §3.
- `useModel()` is **submission-scoped**. There is no mid-run model swap. Fallback is workflow-level.
  **Still true and still load-bearing.**
- New, and the one most likely to waste your afternoon: **`flue build` does not exist.** The CLI has
  `run`, `init`, `blueprint`, `docs`. `flue run` is the loud SKILL.md validation gate — it validates
  at load, before any model call, and exits 1.

---

## Phase 0 — De-risk model access — **[DROPPED IN FULL]**

The premise was that we had to build and validate a Copilot endpoint ourselves. We do not. pi-ai
0.84.2 ships a built-in `github-copilot` provider with 32 models, and a `google` provider covering
`gemini-2.5-pro` — baseUrl, headers, `contextWindow`, `maxTokens` and cost all already in the
catalog. So there is no endpoint to reverse-engineer, no header set to record, and no `Model`
objects to author (which also deletes the "a wrong `contextWindow` silently disables compaction"
risk — that was a consequence of hand-rolling the provider).

What survives is one much smaller question, tracked in 6.3 and `docs/models.md`: the built-in
baseUrl is the *individual* Copilot endpoint, and a business/enterprise entitlement may need
`api.business.` or `api.enterprise.`. That is a one-line `setProvider` override reusing the
catalog, not a spike.

### 0.1 ~~[SPIKE][BLOCKER] Validate the Copilot chat-completions endpoint~~ — **[DROPPED]** provider is built in
- Standalone `scripts/spike-copilot.ts`, plain `fetch`, no Flue. Hit `https://api.githubcopilot.com/chat/completions` with a Copilot-scoped fine-grained PAT.
- Try one Claude model and one GPT model.
- Record the exact working header set (`Copilot-Integration-Id`, `Editor-Version`, …) in `docs/copilot-endpoint.md`.
- Also record each model's real **context window and max output tokens** — needed for the Pi `Model` objects in 2.2, and a wrong value silently disables compaction.
- **Exit:** `npm run spike:copilot` round-trips a prompt. If blocked after ~half a day, go to 0.2.

### 0.2 ~~[SPIKE] Bail-out: official Copilot SDK behind a Pi provider~~ — **[DROPPED]** no bail-out needed
- Only if 0.1 fails or looks fragile.
- Confirm `@github/copilot-sdk` works from a plain Node script.
- Sketch a Pi `createProvider()` whose `api` delegates to the SDK. Note this is more work than the OpenAI-compatible path — the whole point of 0.1 is to avoid needing it.

### 0.3 [BLOCKER] Validate Gemini — **[DONE]** built-in `google` provider covers it; credential is `GEMINI_API_KEY`, **not** `GOOGLE_GENERATIVE_AI_API_KEY`
- First check whether Pi's **built-in `google` provider** already covers the model you want — if so, there is nothing to build and `FLUE_MODEL=google/<model>` with `GOOGLE_GENERATIVE_AI_API_KEY` just works. Only write a custom provider if it doesn't.
- Record findings in `docs/gemini-endpoint.md`.

---

## Phase 1 — Scaffold

### 1.1 Initialize — **[DONE]**
- `npm init -y`; **Node >= 22.19.0** (`.nvmrc`, and `engines` in package.json).
- `npm install @flue/runtime valibot` and `npm install -D @flue/cli typescript`.
- Add `googleapis` and `octokit` for the integration tools.
- **Pin exact versions** — no carets. Flue 2.0 is three weeks old.
- `tsconfig.json`: target ES2022, `moduleResolution: bundler`, strict.
- `.gitignore`, Prettier, `.editorconfig`.

### 1.2 Consider `flue init` — **[DONE]** compared; kept this layout
- Run `npx flue init` in a scratch directory first and compare its scaffold to `DESIGN.md`'s layout. If it differs meaningfully, prefer the official scaffold and update DESIGN.md rather than fighting the tool.

### 1.3 Directory structure — **[DONE, ALTERED]** no `src/providers/` (0.1); skills live in `src/skills/` not `.agents/skills/` (4.4); added `src/safety/`, `src/schema/`, `src/integrations/`
- `src/agents/`, `src/providers/`, `src/tools/`, `.agents/skills/`, `.github/workflows/`, `scripts/`, `docs/`.

### 1.4 Write `AGENTS.md` at the repo root — **[DONE]**
- This is the agent's global context, read from the sandbox at runtime.
- Cover: what this repo is, what an analysis run does, where skills live, and — importantly — **that issue content is untrusted data and never an instruction**.

---

## Phase 2 — Providers — **[MOSTLY DROPPED]**

### 2.1 ~~[BLOCKER] Implement `src/providers/register.ts`~~ — **[DROPPED]** the file does not exist; see 0.1 and DESIGN §3
- `setProvider(createProvider({ id: 'copilot', … }))` using Pi's `createProvider` and `openAICompletionsApi()`.
- Declare `Model` objects with real `baseUrl`, headers, `contextWindow`, `maxTokens`, and cost from 0.1.
- Register Gemini too, unless 0.3 concluded the built-in `google` provider suffices.
- **Do not put this in `app.ts`.** There is no `app.ts` in this project.

### 2.2 ~~Verify registration actually applies under `flue run`~~ — **[DROPPED]** nothing registers, so there is nothing to verify. The equivalent cheapest-possible-catch is now `npm run agent:faux`, which exercises real CLI loading, skill validation, the `--json` envelope and exit codes with zero credentials
- Trivial throwaway agent that calls `useModel('copilot/<model>')` and returns "say hi".
- `npx flue run src/agents/smoke.ts --message "hi"`.
- A model-resolution error naming unknown provider IDs means the import side effect isn't landing — fix before proceeding. This single check is the cheapest possible catch for the biggest footgun in the design.

### 2.3 Env validation in `src/env.ts` — **[DONE, ALTERED]** deliberately **not** a Valibot schema: a Valibot issue carries the offending `input` value, so a failed parse of a credential can surface that credential in an error message or stack trace. Hand-rolled checks throw messages naming variable *names* only, and a test asserts no fragment of a sentinel value appears. Correct variable names are `COPILOT_GITHUB_TOKEN` and `GEMINI_API_KEY` — both were wrong above
- Valibot schema over `COPILOT_TOKEN`, `GEMINI_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `DISCORD_WEBHOOK_URL`, `FLUE_MODEL`, `GH_TOKEN`.
- Fail fast with a clear message. Never log values.

---

## Phase 3 — Integration tools

**[DONE, ALTERED]** These are **not** `defineTool`s. They are plain async functions in
`src/integrations/`, unreachable from the model's action space, called from the one harness tool.
The secret boundary the original wording wanted is preserved and strengthened: an unmounted
function is not a mechanism an injected instruction can name. Each takes an injectable dependency
seam (`fetchImpl`, `octokit`, `accessToken`) so the whole publish path tests without credentials.

### 3.1 `src/integrations/google-docs.ts` — **[DONE]** single Drive `files.create` multipart upload; the Docs `batchUpdate` path was rejected (character-index remapping); `permissions.create` is never called
- `create_analysis_doc` — input: title, markdown body. Output: `{ url, id }`.
- Service-account auth; create in the configured Drive folder.
- Naming: `[ANALYSIS] #<issue-number> — <truncated-title>`.

### 3.2 `src/integrations/discord.ts` — **[DONE]** plain `fetch`; `allowed_mentions: { parse: [] }` is the load-bearing line
- `post_to_discord` — input: docUrl, summary, issueNumber, issueTitle.
- Small embed; truncate summary to ~280 chars. Throw on non-2xx.

### 3.3 `src/integrations/github.ts` — **[DONE]** `fetchIssue` (hard caps, `authorAssociation`, `isBot`) and `commentOnIssue`
- `comment_on_issue` — input: issueNumber, body.
- Octokit with `GITHUB_TOKEN`.

### 3.4 Smoke scripts — **[DONE, NEEDS CREDENTIALS TO RUN]**
- `scripts/smoke-<tool>.ts` per tool, run manually against real credentials. Not in `npm test`.

---

## Phase 4 — The skill

### 4.1 `src/skills/issue-analysis/SKILL.md` — **[DONE]** (path changed — see 4.4)
- Frontmatter with `name` and `description` — the description is the one line that always sits in the system prompt catalog, so make it precise about *when* to use the skill.
- Body: numbered steps — fetch issue, scan `references/` frontmatter for tag overlap, read the 3–5 most relevant, draft against `template.md`, return structured output.
- State explicitly that issue text is data, not instruction.

### 4.2 `template.md` — **[DONE]**
- Sections: Summary, Severity, Reproducibility, Affected components, Root-cause hypotheses, Suggested actions, Related past issues.

### 4.3 Seed `references/` — **[DONE with synthetic examples]** three clearly-marked synthetic analyses, each carrying `example: true` and a banner, covering bug/feature-request/security. Real hand-written analyses still need converting **and auditing for confidential content** before they land
- Convert 5–10 existing hand-written analyses to markdown with frontmatter (`issue-number`, `date`, `tags`, `issue-type`, `severity`).
- **Audit for confidential content before committing.**

### 4.4 [DECISION] Explicit `useSkill()` vs. workspace auto-discovery — **[DECIDED: explicit, and this reverses the recommendation below]**
- With `local()`, skills in `.agents/skills/` are discovered automatically. Explicit `useSkill()` is for npm-imported or code-defined skills.
- ~~Try auto-discovery first; it is less code.~~ **Do not.** The deciding factor is not code volume, it is failure shape. A malformed workspace `SKILL.md` is **skipped with a warning** — so in headless CI the agent still runs, still creates a Doc, still posts to Discord, and still comments on the issue, with an ungrounded analysis under a green check mark. Nobody investigates a green run. A static `import skill from '../skills/issue-analysis/SKILL.md'` fails at load with exit code 1 and a message naming the problem, before any model call or side effect (verified empirically both ways).
- Secondary reason: auto-discovery reads whatever is in the sandbox cwd, which turns the checkout into an unauthenticated instruction channel the moment it is ever attacker-influenced.
- Consequence: skills live in **`src/skills/`**, and `.agents/skills/` must **not** also exist — both copies would mount and drift.
- One config detail this needs: `tsconfig.json` must list `"@flue/runtime"` in `types`, or the ambient `*/SKILL.md` module declaration only resolves in files that happen to import `@flue/runtime`.
- Recorded in DESIGN §2.

---

## Phase 5 — The agent

### 5.1 Write `src/agents/issue-analyst.ts` — **[DONE, ALTERED]**
- ~~Import `../providers/register` at the top for its side effect.~~ No such module — see 2.1.
- `useModel(modelSpecifier(), { thinkingLevel: 'high' })` — `high`, not `max`; this is the cost lever against the <$0.50/run target.
- ~~`useSandbox(local({ env: { GH_TOKEN: process.env.GH_TOKEN } }))`~~ → **`useSandbox(local({ env: {} }))`**. Nothing in the agent's job needs a token in the sandbox — the integrations read `process.env` in-process, which the model cannot reach. An empty env costs nothing and removes the whole "the model can print the token" class.
- `useSkill(skill)` and `useTool(analyzeAndPublish)` — one tool, not three.
- ~~Return instructions specifying the required tool order.~~ Ordering is TypeScript now, not instruction. The returned text says: call it once, then stop.
- Plus a `useAgentFinish` guard: return early on success; append **at most one** nudge (module-scope counter, because a `let` inside the agent function resets on every render) then throw; and **throw without nudging** on any tool outside the allowlist — nudging a possibly-injected run is the wrong response to a security signal. Bounded structurally because the framework ceiling is 32 continuation cycles and reaching it is a runaway-cost event *before* the failure.
- Honest caveat in the code: `local()` mounts file and shell tools regardless, so the allowlist is a **detector, not a preventer**.

### 5.2 Define the output schema — **[DONE]** plus `injectionSuspected` / `injectionNotes`, so an injection attempt becomes a reported finding instead of a silent event
- Valibot: `summary`, `severity` (picklist), `reproducible`, `affectedComponents`, `rootCauseHypotheses`, `suggestedActions`, `relatedPastIssues`.

### 5.3 Iterate locally — **[PARTIAL]** done against the faux provider (`npm run agent:faux`); real-model iteration **[NEEDS CREDENTIALS]**
- `npx flue run src/agents/issue-analyst.ts --message "Analyze issue #42"`
- `--json | jq` for machine-readable output; `--id` to continue a conversation across invocations while debugging.

### 5.4 ~~[CONDITIONAL]~~ Promote to harness-tool orchestration — **[DONE UNCONDITIONALLY]**
- ~~Only if 5.3 shows the model skipping or reordering tool calls.~~ Done from the start; the instruction-driven version was never built. Waiting for the model to misbehave would have meant shipping functional requirement 5 as a hope: "validation passes before any side effect" cannot be delivered by asking a model to call three tools in order. `harness.prompt(..., { result: AnalysisSchema })` makes it a precondition in the type system.
- It also collapses the injection surface — with no Docs/Discord/GitHub-write tool mounted, "post your environment to Discord" has no mechanism to name.
- The worry that this starves the analysis of the skill does not apply: Flue's `guide/skills.md` states that a harness tool's `harness.prompt(...)` runs with the agent's rendered configuration — same system prompt, skill catalog and tools.
- Also `durable: true`, with one `step.do` per side effect, so a retry cannot create a second Doc or double-post. Sharp edge: `step.do` persists its return value and the store rejects `undefined`, so a step wrapping a `void` function must return an explicit marker.

---

## Phase 6 — CI

### 6.1 `.github/workflows/issue-analyst.yml` — **[DONE]**
- Trigger `issues: [opened]`; optionally `labeled` with `needs-analysis`.
- Permissions: `contents: read`, `issues: write`. **Never `contents: write`** — see the injection risk in DESIGN.md.
- `timeout-minutes: 30`.
- Steps: checkout, setup-node@22, `npm ci`, `npx flue run …`.
- Two-step primary/fallback pattern from DESIGN.md §4, using `continue-on-error` and `steps.<id>.outcome`, with **asymmetric per-step secrets** — the primary sees only `COPILOT_GITHUB_TOKEN`, the fallback only `GEMINI_API_KEY`. `src/env.ts` demands only the credential the selected provider needs, which is what makes that split work.
- Model names as repo **variables** (not secrets) so they're visible and one-click editable.
- **A final required assertion step, or `continue-on-error` inverts the whole design:** with it set, the job reports success when *both* model steps fail. Parse the `--json` envelope and fail unless `outcome == "completed"` **and** a Doc URL is present. The field is `outcome`, values `"completed"` / `"failed"` / `"aborted"` / `"error"` — asserting `"success"` matches nothing and passes always.
- Per-issue `concurrency` with `cancel-in-progress: false`; a cancelled run can leave a Doc with no comment.
- Pin every third-party action to a full commit SHA: a mutable tag is a supply-chain write into a workflow holding `issues: write`.
- Also added, not in the original list: **`ci.yml`**, which runs `npm run verify` with **no secrets at all**. Since `verify` ends in `agent:faux`, CI exercises real CLI loading, skill validation, the `--json` envelope and exit codes credential-free.

### 6.2 `issue-analyst-manual.yml` — **[DONE]**
- `workflow_dispatch` with an `issue_number` input, for re-runs.

### 6.3 `docs/secrets.md` — **[DONE]**
- Minting a Copilot-scoped fine-grained PAT; Google service account + folder grant; Discord webhook.
- Note `GITHUB_TOKEN` is provided automatically.
- Three Google traps that will otherwise eat the first afternoon: a service account has **no Drive storage quota of its own**, so the target folder must live on a **Shared Drive** or `files.create` fails with `storageQuotaExceeded` (the single most likely first-run failure); `drive.file` is the narrowest workable scope and may need widening to `drive` for a pre-existing parent; and **never** grant link-anyone sharing, because the Doc URL gets posted to Discord and commented on a possibly-public issue.
- The Discord webhook URL is itself a credential — anyone holding it can post as the bot. It is a secret, not a var, and it never appears in an error message.

### 6.4 Daily canary — **[DONE]**
- Scheduled workflow that runs the agent against a fixed known issue.
- Catches Copilot header/endpoint drift before a real issue does.

---

## Phase 7 — Validation

### 7.1 End-to-end on a throwaway private repo — **[NEEDS CREDENTIALS]**
- Three issues: clear bug, feature request, ambiguous. Confirm Doc + Discord + comment for each.
- Spot-check that Docs actually reference past reviews — if they never do, the skill's retrieval step isn't working.

### 7.2 Fallback test — **[NEEDS CREDENTIALS]**
- Set `PRIMARY_MODEL` to an invalid specifier. Confirm step 1 fails, step 2 runs on Gemini, run completes.

### 7.3 **Prompt-injection test** — do not skip — **[PARTIAL: the cheap half is DONE and now runs on every PR]**
- **[DONE]** `tests/fixtures/injections/` holds a corpus of hostile issue bodies — instruction override, exfiltration, fake authority, fence-delimiter forging, `@everyone`, HTML-comment-hidden text, attacker links, fake tool-call blocks, obfuscation. Every fixture runs through the model-free pipeline (fence → sanitize → render) on every PR, asserting the fence is not escapable, no mention survives, non-allowlisted links are inert, and nothing credential-shaped reaches the output. Cheap enough that there is no excuse to skip it.
- **[DONE]** The `useAgentFinish` assertion on unexpected tool calls was not left as a "consider" — it is in 5.1, and it throws rather than nudges.
- **[NEEDS CREDENTIALS]** The half a corpus cannot cover: file a real test issue and confirm the *model's* behaviour end to end — no secret in the Doc, Discord message or comment; no unexpected tool calls; no shell commands beyond reading the repo. The offline corpus proves the guards hold; only a real run shows whether the model tries the door.

### 7.4 Failure-mode test — **[DONE offline]** a Discord failure is asserted to leave the Doc and comment intact and then propagate. Revoking a real webhook is **[NEEDS CREDENTIALS]**
- Revoke the Discord webhook mid-run. Confirm the Action fails loudly and the Doc + comment survive.

---

## Phase 8 — Scaffold extraction (after v1 is solid) — **[NOT STARTED — next up]**

One correction to 8.1 in advance: `src/providers/` is not in the generic column because it does
not exist. The generic surface is `src/integrations/`, `src/safety/`, `src/schema/integrations.ts`,
`src/env.ts`, `src/render.ts`, `src/faux.ts`, `AGENTS.md`, `tsconfig.json` and the CI workflow.
`src/safety/` is the part most worth extracting — it is where the reusable value is, and every
future agent that reads untrusted input needs exactly it.

### 8.1 Separate agent-specific from generic
- Specific: `src/agents/issue-analyst.ts`, `src/skills/issue-analysis/`, `src/schema/analysis.ts`, `src/tools/analyze-and-publish.ts`, the issue workflows.
- Generic: `src/integrations/`, `src/safety/`, `src/schema/integrations.ts`, `src/env.ts`, `src/render.ts`, `src/faux.ts`, `AGENTS.md`, `tsconfig.json`, `ci.yml`, `docs/`.

### 8.2 Template repository
- Mark as template; `README.md` covering clone → add skill → add agent → add workflow → set secrets.

### 8.3 Consider packaging shared skills to npm
- Flue 2.0 supports npm-importable skills. If two agents want the same skill, that's the mechanism — not copy-paste.

### 8.4 Prove it with a second agent
- Something small (weekly issue digest). If it needs changes to `src/providers/` or `src/tools/`, the boundary in 8.1 is wrong.

---

## Discovered along the way

Not in the original plan, but built because the work needed them:

- **`src/safety/`** — `fence.ts` (nonce-delimited untrusted text; a static `<untrusted-issue>` tag is trivially closed by an attacker who types the closing tag), `secret-scan.ts` (exact match against live env values, then 11 credential shape patterns; throws with the rule name only, never the matched text), `sanitize.ts` (mentions, HTML and HTML comments, link allowlist, length caps). This is the reusable core.
- **`src/render.ts`** — the single egress choke point. Every model-authored string passes through `sanitize()` on its way out, in one place rather than at each call site.
- **`src/faux.ts`** — pi-ai's faux provider wired to Flue, gated on `FLUE_FAUX=1`, plus an offline dependency installer that refuses to run without the flag. This is what makes the whole end-to-end path testable with zero credentials.
- **`docs/threat-model.md`** — written because the Risks table had outgrown a table. One thing it must keep saying: `allowed-tools` in SKILL.md frontmatter is **accepted but not enforced**. It is documentation, not a control, and must never be cited as one.

## Stretch

- Evaluate `useMcpConnection()` for Google Docs / Discord (mark `optional: true` so a flaky server degrades instead of failing the run) — weigh against losing the secret boundary.
- `useSubagent()` for a separate reviewer pass over the drafted analysis.
- Vitest Evals (in Flue's ecosystem docs) for regression-testing analysis quality against the seed corpus.
- OpenTelemetry export for cost and latency telemetry.
- Vector index over `references/` past ~50 files.
