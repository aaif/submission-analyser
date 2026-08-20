# Models

## Specifier format

A model is named `<provider-id>/<model-id>`, and model ids carry **dots**, not dashes, in
their version numbers:

```
github-copilot/claude-opus-4.7
github-copilot/claude-sonnet-4.6
```

Exactly two segments, both non-empty. `modelSpecifier()` enforces that, because the shape is
easy to get subtly wrong: `github-copilot//claude-opus-5` — one stray slash — once passed the
provider check (splitting on `/` and taking element 0 still gives `github-copilot`) and died
deep in the runtime with `Unknown model ID "/claude-opus-5"`, which names the symptom instead
of the typo. It now fails immediately, quoting the specifier back.

## One provider: GitHub Copilot

**All model access goes through GitHub Copilot.** `src/env.ts` enforces it —
`requireModelCredential()` rejects any specifier whose provider id is not `github-copilot`,
and the only model credential in the project is:

| Provider id      | Credential             | Where it comes from                    |
| ---------------- | ---------------------- | -------------------------------------- |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` | Fine-grained PAT, personal account, **Copilot Requests: read-only** (the only level offered) |

The provider is a pi-ai built-in that `flue run` registers for us — there is no hand-written
provider module in this repository. (If you are reading an older draft: `COPILOT_TOKEN` is
wrong, and so is the `google` / `GEMINI_API_KEY` fallback leg. Copilot serves the fallback
model too, so that second credential bought nothing.)

The check is in code rather than only in this document because `FLUE_MODEL` is supplied from a
repository **variable**, which any maintainer can change in one click with no review, and
`flue run` registers *every* pi-ai built-in provider unconditionally. Without the guard,
`FLUE_MODEL=anthropic/...` plus an `ANTHROPIC_API_KEY` secret would quietly work — and start
sending issue text to a vendor nobody agreed to send it to.

## Only 10 of Copilot's 32 models are reachable with a PAT

**Read this before choosing a model.** The catalog is not the menu.

`MODELS['github-copilot']` lists 32 models across four vendors, split by API family:

| Family | Count | Models |
| --- | --- | --- |
| `anthropic-messages` | 10 | `claude-haiku-4.5`, `claude-opus-4.5`/`4.6`/`4.7`/`4.8`/`5`, `claude-sonnet-4`/`4.5`/`4.6`/`5` |
| `openai-responses` | 14 | `gpt-5.*`, `grok-4.5`, `mai-code-*` |
| `openai-completions` | 8 | `claude-fable-5`, `gemini-*`, `gpt-4.1`, `kimi-*` |

The 22 OpenAI-shaped models **cannot be used with a personal access token**. Copilot's
OpenAI-shaped endpoints reject one outright:

```
400 checking third-party user token: bad request:
Personal Access Tokens are not supported for this endpoint
```

That is not a permission we forgot to tick — the `Copilot Requests` permission has one level,
read-only, and it is already granted. The endpoint refuses the *credential type*. The
`anthropic-messages` endpoint does accept it. So under the credential this project uses, the
Claude models are the whole selection.

This was discovered the hard way: the fallback leg was `github-copilot/gpt-5.4`, chosen
specifically so that one credential would still buy a different vendor. It never worked, and
the canary is what said so — which is the argument for the canary matrix covering *both* legs.

## The two configured models

- **Primary — `github-copilot/claude-opus-4.7`.** 1M-token context window, $5/M input and
  $25/M output at the catalog's listed rates. This is also `DEFAULT_MODEL` in `src/env.ts`,
  so an unset `FLUE_MODEL` lands here.
- **Fallback — `github-copilot/claude-sonnet-4.6`.** A smaller, cheaper model on a different
  serving pool.

**The fallback does not buy vendor diversity, and earlier drafts of this file claimed it
did.** Both legs are Anthropic models behind one provider, so a vendor-level Anthropic outage
takes out both, and so does a Copilot outage or a rejected token. What it does cover is the
more common case: a capacity blip, a rate limit, or a bad deploy on one specific model.

If real vendor diversity is ever a requirement, PAT auth cannot deliver it and the options
are all bigger than a config change — pi-ai's OAuth device flow (which also fixes the
business/enterprise endpoint problem, but needs an interactive login to seed CI), the GitHub
Models API, or dropping the single-provider rule and taking on a second credential.

The workflows read these from the repo **variables** `PRIMARY_MODEL` and `FALLBACK_MODEL`,
falling back to the values above when unset. Variables, not secrets: a model id is not
sensitive, and changing it during an incident should be one visible click.

Fallback is a *second workflow step*, not an in-run retry. `useModel()` is
submission-scoped — the runtime reads it once when a submission starts — and a one-shot CI run
is a single submission, so there is no mid-run swap available. See DESIGN.md §4.

## `FLUE_MODEL`

`modelSpecifier()` in `src/env.ts` resolves, in order:

1. `FLUE_FAUX` set → `faux/faux-1`, the credential-free fake provider in `src/faux.ts`. This
   wins over everything, including `FLUE_MODEL`.
2. `FLUE_MODEL` set → that specifier verbatim.
3. Otherwise → `github-copilot/claude-opus-4.7`.

So to try another model for one run:

```bash
FLUE_MODEL=github-copilot/claude-opus-5 npm run agent -- --id 123 --message 'Analyse issue #123'
```

`modelSpecifier()` rejects a specifier that is not exactly `provider/model`, and
`requireModelCredential()` throws before the run spends a single token if the provider is not
`github-copilot` or if `COPILOT_GITHUB_TOKEN` is missing — a typo in a specifier fails in
seconds, not after an analysis.

Pick from the 10 `anthropic-messages` models above. An OpenAI-shaped one will pass both checks
and then be rejected by Copilot at the first model call.

## When Copilot returns 401 or 404 — read this first

**This is the largest residual risk in the project, and it is a one-line fix.**

The built-in `github-copilot` provider points at the **individual** endpoint,
`https://api.individual.githubcopilot.com` — verified in
`node_modules/@earendil-works/pi-ai/dist/providers/github-copilot.js`, and on all 32 model
entries individually. Note that this applies to the **api-key path**, which is the one this
project uses: pi-ai's `envApiKeyAuth` sends `COPILOT_GITHUB_TOKEN` verbatim as the bearer to
that fixed host. Its *OAuth* path derives the host from the `proxy-ep` field of an exchanged
Copilot token instead, so it adapts automatically — but that path needs an interactive device
flow and a refreshable credential, which a one-shot CI job does not have. We get the fixed
host, and therefore this failure mode.

A business or enterprise Copilot entitlement is served from a different host:

- `https://api.business.githubcopilot.com`
- `https://api.enterprise.githubcopilot.com`

A token that is genuinely valid, on an account that genuinely has a seat, will still fail
against the wrong host — and it fails as a 401 or a 404, which reads exactly like a bad
credential. Do not start rotating PATs. Try the host first.

The override reuses the built-in catalog, so no model metadata gets hand-maintained. Note
that in pi-ai each `Model` object carries **its own** `baseUrl`, so overriding only the
provider's `baseUrl` is not enough — the models have to be remapped too:

```ts
// src/providers/copilot-host.ts — imported for its side effect by the agent module.
// `flue run` loads ONLY the agent module, never app.ts, so a setProvider() call anywhere
// else silently does not register.
import { setProvider } from '@flue/runtime';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';

const host = process.env.COPILOT_BASE_URL ?? 'https://api.business.githubcopilot.com';
const base = githubCopilotProvider();

setProvider({
  ...base,
  baseUrl: host,
  getModels: () => base.getModels().map((model) => ({ ...model, baseUrl: host })),
});
```

Registration performs no I/O, so a wrong host still surfaces only on the first model request.
The cheap way to test a candidate host is the **Model canary** workflow: it is a dry run, it
publishes nothing, and it can be dispatched by hand as often as you like.

The other place Copilot drift shows up is **headers**. Every model entry in the catalog
carries its own `headers` — `Copilot-Integration-Id: vscode-chat`, `Editor-Version`,
`Editor-Plugin-Version` and a `User-Agent` naming a VS Code Copilot Chat build (verified: 32
of 32 model entries). That is pi-ai presenting itself as the editor plugin, and those values
have had to move before as GitHub tightened the endpoint. If the host override does not fix
a 401, upgrade `@earendil-works/pi-ai` before editing headers by hand — someone has probably
already tracked the change.

Worth knowing which way the wind is blowing here: GitHub now documents `COPILOT_GITHUB_TOKEN`
as the environment variable for authenticating Copilot CLI with a fine-grained PAT, so a PAT
against this endpoint is a supported pattern rather than a pure reverse-engineering bet. The
editor-impersonating headers are still pi-ai's own choice, not a documented contract.

## Cost

The target is **under $0.50 per run**, and the deliberate lever pushing against it is
`thinkingLevel: 'high'` in `src/agents/issue-analyst.ts`. That is a considered trade, not an
oversight: this agent runs once per filed issue, a handful of times a day, and its output is
read by maintainers deciding what to do about a bug report. A shallow, confidently wrong
triage costs far more human time than the extra thinking tokens cost money. If cost ever does
become the binding constraint, turn `thinkingLevel` down before you reach for a cheaper model
— the analysis quality is the product.

The other cost controls are already structural:

- Issue ingest is bounded — 20,000 body chars, 20 comments, 4,000 chars each
  (`src/integrations/github.ts`), so a pathological issue body cannot become a giant bill.
- Every field of the analysis schema is length-bounded (`src/schema/analysis.ts`).
- The continuation guard allows exactly one nudge before it fails the run
  (`src/agents/issue-analyst.ts`). The framework's own ceiling is 32 continuation cycles; 32
  extra turns at `thinkingLevel: 'high'` is a runaway-cost event that would arrive *before*
  any loud failure, which is why the bound is structural rather than a request.

**Where per-run cost actually shows up.** The publish tool records it: after the analysis
step, `src/tools/analyze-and-publish.ts` calls `log.info('analysis complete', …)` with the
model that answered (`provider/id`), `totalTokens`, and `costUsd` taken from the provider's
own usage accounting. That is the number to check after changing a model or `thinkingLevel`.

Be aware of where it lands, though. `log.info` emits a **structured log event into the
conversation activity stream**, and `flue run`'s presenter renders only message text,
thinking, and tool start/finish markers — it does not print log events. So the cost line does
*not* appear in the workflow step log, and neither does the Doc URL. (Verified by running
`npm run agent:faux` and reading the full output: the run prints
`tool done analyze_and_publish` and nothing else about the tool.)

To read it, query the conversation store — `flue run` prints its path on startup as the `db`
row, `node_modules/.cache/flue/run.db` by default — or add surfacing of your own. Until
something surfaces it, the practical signals in CI are coarser: **which step ran** tells you
which model answered (a green "Analyse (fallback model)" step means the primary failed), and
the step's duration is a rough proxy for how much thinking happened. If per-run cost matters
enough to track, that gap is worth closing deliberately rather than assuming the number is
already in the log.
