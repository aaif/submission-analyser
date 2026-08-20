# Models

## Specifier format

A model is named `<provider-id>/<model-id>`, and model ids carry **dots**, not dashes, in
their version numbers:

```
github-copilot/claude-opus-4.7
github-copilot/gpt-5.4
```

## One provider: GitHub Copilot

**All model access goes through GitHub Copilot.** `src/env.ts` enforces it —
`requireModelCredential()` rejects any specifier whose provider id is not `github-copilot`,
and the only model credential in the project is:

| Provider id      | Credential             | Where it comes from                    |
| ---------------- | ---------------------- | -------------------------------------- |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` | Fine-grained PAT with Copilot Requests |

The provider is a pi-ai built-in that `flue run` registers for us — there is no hand-written
provider module in this repository. (If you are reading an older draft: `COPILOT_TOKEN` is
wrong, and so is the `google` / `GEMINI_API_KEY` fallback leg. Copilot serves the fallback
model too, so that second credential bought nothing.)

The check is in code rather than only in this document because `FLUE_MODEL` is supplied from a
repository **variable**, which any maintainer can change in one click with no review, and
`flue run` registers *every* pi-ai built-in provider unconditionally. Without the guard,
`FLUE_MODEL=anthropic/...` plus an `ANTHROPIC_API_KEY` secret would quietly work — and start
sending issue text to a vendor nobody agreed to send it to.

## The two configured models

Copilot's catalog carries 32 models from four vendors, so the fallback still gets real vendor
diversity — by model, not by provider.

- **Primary — `github-copilot/claude-opus-4.7`.** 1M-token context window, $5/M input and
  $25/M output at the catalog's listed rates. This is also `DEFAULT_MODEL` in `src/env.ts`,
  so an unset `FLUE_MODEL` lands here.
- **Fallback — `github-copilot/gpt-5.4`.** A different lab (1M context, $2.5/M in, $15/M
  out), so a Claude-side outage or a bad Claude deploy does not take out both legs.

What this fallback does *not* cover is Copilot itself: if the Copilot endpoint is down or the
token is rejected, both legs fail together. That is the accepted cost of one credential. The
failure is loud — the assert step turns it into a red run and a comment on the issue — and the
remedy is to run the analysis by hand, not to keep a second vendor account warm all year for
an outage that has not happened.

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
FLUE_MODEL=github-copilot/gpt-5.4 npm run agent -- --id 123 --message 'Analyse issue #123'
```

`requireModelCredential()` throws before the run spends a single token if the provider is not
`github-copilot` or if `COPILOT_GITHUB_TOKEN` is missing — a typo in a specifier fails in
seconds, not after an analysis.

## When Copilot returns 401 or 404 — read this first

**This is the largest residual risk in the project, and it is a one-line fix.**

The built-in `github-copilot` provider points at the **individual** endpoint,
`https://api.individual.githubcopilot.com`. A business or enterprise Copilot entitlement is
served from a different host:

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

The other place Copilot drift shows up is **headers**. The catalog's model entries carry
`Copilot-Integration-Id`, `Editor-Version` and a `User-Agent`; this endpoint is not officially
documented for third-party programmatic use, and those values have had to move before. If the
host override does not fix it, upgrade `@earendil-works/pi-ai` before you start editing
headers by hand — someone has probably already tracked the change.

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
