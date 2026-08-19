# Models

## Specifier format

A model is named `<provider-id>/<model-id>`, and model ids carry **dots**, not dashes, in
their version numbers:

```
github-copilot/claude-opus-4.7
google/gemini-2.5-pro
```

Both providers are pi-ai built-ins that `flue run` registers for us — there is no
hand-written provider module in this repository. Each provider declares which environment
variable holds its credential, and `src/env.ts` checks it up front:

| Provider id      | Credential             | Where it comes from                        |
| ---------------- | ---------------------- | ------------------------------------------ |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` | Fine-grained PAT with Copilot Requests     |
| `google`         | `GEMINI_API_KEY`       | AI Studio API key                          |

(If you are reading an older draft: `COPILOT_TOKEN` and `GOOGLE_GENERATIVE_AI_API_KEY` are
both wrong. The names above are the ones the providers actually read, and the ones
`src/env.ts` validates.)

## The two configured models

- **Primary — `github-copilot/claude-opus-4.7`.** 1M-token context window, $5/M input and
  $25/M output at the catalog's listed rates. This is also `DEFAULT_MODEL` in `src/env.ts`,
  so an unset `FLUE_MODEL` lands here.
- **Fallback — `google/gemini-2.5-pro`.** A genuinely different vendor on a genuinely
  different network path, which is the point: a fallback that shares an outage with the
  primary is not a fallback.

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
FLUE_MODEL=google/gemini-2.5-pro npm run agent -- --id 123 --message 'Analyse issue #123'
```

`requireModelCredential()` maps the provider id to its credential variable and throws before
the run spends a single token if it is missing — a typo in a specifier fails in seconds, not
after an analysis.

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
