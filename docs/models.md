# Models

## Specifier format

A model is named `<provider-id>/<model-id>`, and model ids carry **dots**, not dashes, in
their version numbers:

```
github-copilot/claude-opus-4.7
github-copilot/gpt-5.4
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
| `github-copilot` | `COPILOT_GITHUB_TOKEN` | Fine-grained PAT owned by a **user** account with a Copilot seat (an org-owned token cannot carry the permission), **Copilot Requests: read-only** — the only level offered. See docs/secrets.md §1. |

The provider is a pi-ai built-in that `flue run` registers for us — there is no hand-written
provider module in this repository. (If you are reading an older draft: `COPILOT_TOKEN` is
wrong, and so is the `google` / `GEMINI_API_KEY` fallback leg. Copilot serves the fallback
model too, so that second credential bought nothing.)

The check is in code rather than only in this document because `FLUE_MODEL` is supplied from a
repository **variable**, which any maintainer can change in one click with no review, and
`flue run` registers *every* pi-ai built-in provider unconditionally. Without the guard,
`FLUE_MODEL=anthropic/...` plus an `ANTHROPIC_API_KEY` secret would quietly work — and start
sending issue text to a vendor nobody agreed to send it to.

## The token exchange — why a PAT alone does not work

**Read this before debugging a Copilot 400.** A GitHub token is not a Copilot token.

Copilot's inference endpoints do not accept a GitHub credential as the bearer. They accept a
short-lived *Copilot* token, which looks like

```
tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
```

and which you get by presenting a GitHub token to
`https://api.github.com/copilot_internal/v2/token` with the Copilot editor headers. Send a
PAT to the inference endpoint directly and every model, on every API family, replies:

```
400 checking third-party user token: bad request:
Personal Access Tokens are not supported for this endpoint
```

pi-ai has two Copilot credential paths and **only one of them does the exchange**. Its OAuth
path runs a device flow, exchanges, and refreshes. Its api-key path — `envApiKeyAuth` reading
`COPILOT_GITHUB_TOKEN`, which is the path a headless CI job gets — sends the value *verbatim*.
So the credential arrives one step short of usable, and the failure looks like a bad token.

`src/providers/copilot-auth.ts` does the missing step at agent-module load, in about 40 lines,
and writes the exchanged token back to `COPILOT_GITHUB_TOKEN` (which `envApiKeyAuth` reads
lazily at the first model call). We did not adopt pi-ai's OAuth path instead because it needs
an interactive browser login to seed and a writable credential store to refresh, and a
one-shot Actions run has neither.

### Two things this fixed for free

- **The host.** The exchanged token carries `proxy-ep=`, which names the account's own proxy,
  so individual / business / enterprise is now read from the response instead of guessed
  between three hardcoded hostnames. That was previously documented as this project's largest
  residual risk; it is now handled, and the proxy host is validated against
  `*.githubcopilot.com` before it becomes a base URL.
- **Where it fails.** A rejected credential now fails at the exchange, naming the variable and
  the HTTP status, rather than as an opaque 400 from an inference endpoint mid-run.

### A wrong turn worth recording

The first diagnosis was that Copilot's *OpenAI-shaped* endpoints reject PATs and its
`anthropic-messages` endpoint accepts them — so only the 10 Claude models were usable, and the
fallback was moved off `gpt-5.4` on those grounds. That was wrong. The evidence looked good
(the failing leg's error carried pi-ai's `OpenAI API error` prefix, which only the
`openai-responses` module emits) but the inference did not follow: the Claude leg then failed
with the identical rejection and no prefix. It is the credential type, not the endpoint.

The lesson is narrow and reusable: two legs failing the same way is evidence about what they
share, and both legs shared the credential.

## The two configured models

Copilot's catalog carries 32 models from four vendors, so the fallback gets real vendor
diversity — by model, not by provider.

- **Primary — `github-copilot/claude-opus-4.7`.** 1M-token context window, $5/M input and
  $25/M output at the catalog's listed rates. This is also `DEFAULT_MODEL` in `src/env.ts`,
  so an unset `FLUE_MODEL` lands here.
- **Fallback — `github-copilot/gpt-5.4`.** A different lab (1M context, $2.5/M in, $15/M
  out), so a Claude-side outage or a bad Claude deploy does not take out both legs.

What this fallback does *not* cover is Copilot itself: if the Copilot endpoint is down, or the
token is rejected, or the exchange above fails, both legs fail together. That is the accepted
cost of one credential, and it is exactly what the canary is for.

For reference, the catalog splits by API family as follows — it does not affect model choice,
but it explains the differing error prefixes when one does fail:

| Family | Count | Models |
| --- | --- | --- |
| `anthropic-messages` | 10 | `claude-haiku-4.5`, `claude-opus-4.5`/`4.6`/`4.7`/`4.8`/`5`, `claude-sonnet-4`/`4.5`/`4.6`/`5` |
| `openai-responses` | 14 | `gpt-5.*`, `grok-4.5`, `mai-code-*` |
| `openai-completions` | 8 | `claude-fable-5`, `gemini-*`, `gpt-4.1`, `kimi-*` |

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

`modelSpecifier()` rejects a specifier that is not exactly `provider/model`, and
`requireModelCredential()` throws before the run spends a single token if the provider is not
`github-copilot` or if `COPILOT_GITHUB_TOKEN` is missing — a typo in a specifier fails in
seconds, not after an analysis.

## When Copilot returns 401 or 404

**Most of this section used to be the project's largest residual risk. The token exchange
retired it.** The host is no longer guessed: `src/providers/copilot-auth.ts` reads `proxy-ep`
off the exchanged token and remaps the provider *and* every model to it, so an individual,
business or enterprise entitlement is handled by reading the response.

Kept because the reasoning still applies if the exchange itself is ever bypassed: the built-in
`github-copilot` provider hardcodes the **individual** endpoint,
`https://api.individual.githubcopilot.com` — verified in
`node_modules/@earendil-works/pi-ai/dist/providers/github-copilot.js` and on all 32 model
entries individually. Business and enterprise seats are served from
`api.business.githubcopilot.com` and `api.enterprise.githubcopilot.com`, and a genuinely valid
token against the wrong host fails as a 401 or 404 — which reads exactly like a bad
credential. Note that each pi-ai `Model` object carries **its own** `baseUrl`, so overriding
only the provider's is not enough; that is why `applyCopilotAuth()` maps `getModels()` too.

So the order to check now is:

1. **Did the exchange succeed?** A failure there names `COPILOT_GITHUB_TOKEN` and the HTTP
   status. 401 or 403 means the token lacks the `Copilot Requests` permission, or the account
   that owns it has no active Copilot seat.
2. **Is the credential a fine-grained PAT owned by a user account with a seat?** Classic tokens
   are not accepted, and *Copilot Requests* is an account permission that does not exist on an
   org-owned token — seats belong to member accounts, not to the org. A machine account in the
   org, holding a seat, is the durable answer. See docs/secrets.md §1.
3. **Headers.** Every model entry carries `Copilot-Integration-Id: vscode-chat`,
   `Editor-Version`, `Editor-Plugin-Version` and a `User-Agent` naming a VS Code Copilot Chat
   build (32 of 32 entries). That is pi-ai presenting itself as the editor plugin, and those
   values have had to move before as GitHub tightened the endpoint. `copilot-auth.ts` copies
   the same four headers, because the exchange also rejects a request without them. If a call
   401s, upgrade `@earendil-works/pi-ai` before editing headers by hand — someone has probably
   already tracked the change.

The cheap way to test any of this is the **Model canary** workflow: it is a dry run, it
publishes nothing, and it can be dispatched by hand as often as you like.

To check a token by hand without a workflow run — this is the exact call
`applyCopilotAuth()` makes, and a 200 with a `token` field means model access will work:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $COPILOT_GITHUB_TOKEN" \
  -H 'Copilot-Integration-Id: vscode-chat' \
  -H 'Editor-Version: vscode/1.107.0' \
  -H 'Editor-Plugin-Version: copilot-chat/0.35.0' \
  -H 'User-Agent: GitHubCopilotChat/0.35.0' \
  https://api.github.com/copilot_internal/v2/token
```

`/copilot_internal/` is, as the path says, internal and undocumented — GitHub does not promise
it to third parties. It is the same call pi-ai's OAuth path makes, so we are not further out on
a limb than the library, but a Copilot upgrade is the thing most likely to break this project.
The canary is what tells you.

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
