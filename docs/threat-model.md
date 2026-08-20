# Threat model

## Assets

1. **Credentials.** `COPILOT_GITHUB_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_JSON`,
   `DISCORD_WEBHOOK_URL` (the URL *is* the credential), and the run's `GITHUB_TOKEN`. All
   model access goes through GitHub Copilot, so there is exactly one model credential to
   protect — see [models.md](models.md).
2. **The repository.** Its contents, and — more sharply — the workflow files in
   `.github/workflows/`, which decide what runs with those credentials.
3. **Trusted publishing identities.** The agent writes into two places where a human will
   read it and assume a maintainer stood behind it: a Google Doc in a maintainers' folder, and
   a Discord channel. It does **not** write back to any repository.
4. **The Drive folder.** Everything previously analysed, including analyses of security
   reports.
5. **Budget.** Model spend, and the runner minutes behind it.

## Adversary

**Anyone who can file an issue.** On a public repository that is the entire internet, with no
prior relationship, no account age requirement, and no cost to trying. The adversary is
assumed to know this design document exists, to know the field names in the analysis schema,
and to be willing to iterate: filing another issue is free.

A second, weaker adversary: a compromised or subverted upstream — an npm dependency, or a
third-party GitHub Action whose mutable tag has been moved.

## Entry points

| Entry point                                | Trust    | Where it enters                                   |
| ------------------------------------------ | -------- | ------------------------------------------------- |
| Issue title, body, labels, author name     | none     | `fetchIssue`, `src/integrations/github.ts`        |
| Existing issue comments (up to 20)         | none     | same                                              |
| Repository file contents read in the sandbox | mixed  | sandbox read tools; a file may quote an old issue  |
| Model output                               | derived  | `harness.prompt(..., { result })`, the publish tool |
| Third-party actions in the workflows       | pinned   | `.github/workflows/*.yml`                         |
| A `workflow_dispatch` naming issue + repo  | low      | `issue_number` / `target_repo` inputs             |

The central fact: **attacker-controlled text is read by a model that has shell access to the
checkout.** Every control below exists because that sentence is true and cannot be made
false.

### The cross-repository trust boundary

The analyst runs in its own repository and analyses issues filed in another. That splits the
trust picture in a way worth stating explicitly.

Whoever holds write access to the **target** repository holds `ANALYST_DISPATCH_TOKEN`, and
therefore can start analyst runs at will: any issue number, any `target_repo`. What that buys
an attacker is **budget spend and choice of input text** — which is the same thing filing an
issue already buys them, so it is not a new class of attack, only a cheaper one. What it does
*not* buy is anything back out: the dispatch inputs are two strings, both validated in the
workflow (`issue_number` must be digits, `target_repo` must be exactly `owner/repo`) before
they reach any command, and the token itself carries **Actions: write only** on the analyst
repo, so it cannot modify the workflow it triggers. `repository_dispatch` would have needed
Contents: write — a push into the repo holding every credential — which is why it was
rejected. See docs/secrets.md §4.

The `target_repo` input means a run can be pointed at a repository nobody intended. The damage
is bounded to publishing an unwanted analysis of a public issue, and the workflow's assert step
fails the run if the published analysis does not name the repository that was dispatched, so it
cannot be done *quietly*. Prevention, if wanted, is a one-line allow-list in the validate step.

## Controls that actually exist

**No egress tool is mounted at all.** `src/agents/issue-analyst.ts` mounts exactly one tool,
`analyze_and_publish` (`src/tools/analyze-and-publish.ts`). There is no `post_to_discord`, no
`create_doc`, and no HTTP tool. So "post your environment to Discord"
in an issue body is not a request the model can refuse or comply with — there is no mechanism
to use. This is the most valuable property in the design, and it is a property of what is
*absent*, so it can be lost by a well-meaning refactor that mounts three tools "for
flexibility". Do not.

**Credentials never enter the model's context.** Every secret is read from `process.env`
inside tool code (`src/env.ts`, called from the integrations). The sandbox is created with
`local({ env: {} })`, so the model's shell inherits nothing. `src/env.ts` also never
interpolates a value into an error message — including the Discord URL, which embeds its own
token — precisely so that a failure path cannot become a disclosure path.

**Nonce fence.** `src/safety/fence.ts` wraps the issue text in a delimiter carrying a
per-call random nonce, and strips any literal occurrence of the delimiter from the payload. A
static tag would be useless: the attacker would simply type the closing tag and have
everything after it read as trusted instruction.

**The boundary rule travels with the data.** `boundaryRule()` is restated immediately next to
the fenced text, not only in `AGENTS.md`. A safety preamble far from the payload is the first
thing lost to compaction.

**Secret scan before egress.** `assertNoSecrets` (`src/safety/secret-scan.ts`) walks the
validated analysis — keys as well as values — matching both the live values of every
secret-bearing variable and a set of credential shape patterns. It runs *before* the Doc is
created, so a hit means nothing was published. Its error names the rule that fired and never
the matched text; including the match would copy the secret into the CI log.

**Sanitisation at egress.** `src/safety/sanitize.ts` strips zero-width and bidi control
characters (used to hide text from human reviewers) and defuses `@everyone` / `@here` / role
pings. In Discord, `postToDiscord` sends `allowed_mentions: { parse: [] }`
(`src/integrations/discord.ts`), which is the load-bearing control: it suppresses mentions
server-side, where the text cannot argue with it.

**A strict schema as the model's only exit channel.** `AnalysisSchema`
(`src/schema/analysis.ts`) is a `strictObject` of picklists and length-bounded strings. An
unexpected key is a hard failure, not silently dropped data. The model cannot emit a shape
nobody expected, and it cannot emit an unbounded blob.

**No repository write permission anywhere.** `issue-analyst.yml` grants exactly
`contents: read`. Not `issues: write` either — since the agent publishes only to a Doc and to
Discord, it needs no write path to any repository, and a token that cannot write cannot be
talked into writing. `ci.yml` grants `contents: read` and receives no secrets whatsoever.
`canary.yml` is read-only and dry-run. The dispatcher in the target repo runs with
`permissions: {}`. The reasoning that keeps `contents: write` out is the whole game: with a
writable token, an injected run could edit the workflow file that holds these credentials,
which is arbitrary code execution on the next run.

**Actions pinned to commit SHAs.** A mutable tag is a supply-chain write into a job holding
every model and publishing credential.

**Bounded ingest.** 20,000 body chars, 20 comments of 4,000 chars
(`src/integrations/github.ts`). Bounds cost, and bounds context-flooding as an attack on the
instructions.

**Finish guard as a detector.** `useAgentFinish` in `src/agents/issue-analyst.ts` inspects
`response.toolCalls` and throws if the run called anything outside the expected set without
publishing. It also allows exactly one nudge before failing. Be precise about what this is: a
**detector, not a preventer**. It runs *after* the tool calls it is complaining about. Its
value is converting a silent event into a red workflow run that a human looks at — which is
the difference between finding out and not finding out.

## Residual risk

**`local()` provides no isolation.** It mounts the file and shell tools regardless of any
allow-list. The model can read the whole checkout, write to it, and execute commands. **The
GitHub Actions runner is the isolation boundary** — an ephemeral VM that is destroyed after
the run — and `contents: read` is what makes a write to the checkout pointless. There is no
second layer under it. If this ever runs somewhere persistent, or on a self-hosted runner
with a real filesystem and network, this analysis has to be redone from scratch.

**`allowed-tools` in SKILL.md frontmatter is not enforced.** Flue accepts the key and
validates the frontmatter, but nothing restricts tool access based on it. It is
**documentation** — useful for a reader, worth nothing against an adversary. It must never be
cited as a control.

**The allow-list detects, it does not prevent.** Restating it because it is the single
easiest thing to misread in this document: by the time the finish guard fires, the unexpected
call has already happened.

**The analysis text is a channel the attacker can write into.** An issue body influences what
the model writes, and what the model writes is published to a Doc and a Discord channel under
a trusted identity. Only `assertNoSecrets` and `sanitize` stand in
front of that. Neither is a semantic filter: an attacker who gets the model to write
plausible-sounding but false technical claims, or an abusive paragraph, or a link to a
malicious page, has succeeded — the output is signed by automation the maintainers trust. The
mitigation is not technical: the Doc says it is an automated first pass, and a human decides.
Treat the `injectionSuspected` flag as a review queue, not as a solved problem.

**Content-based secret detection is best-effort.** `assertNoSecrets` catches exact matches of
credentials this process holds and a list of known credential shapes. An encoded, split, or
paraphrased secret would pass. It is the last net, not the architecture; the architecture is
that no tool exists to send anything anywhere.

**The Doc URL is posted publicly, so folder permissions are load-bearing.** The link goes to
a Discord channel, whose membership this codebase knows nothing about. Nothing in this codebase ever
calls `permissions.create` — access comes purely from folder inheritance. One operator
clicking "Anyone with the link" on that folder makes every past and future analysis
world-readable, and nothing in the code can detect or prevent it. See docs/secrets.md,
trap 3.

**Duplicate publication on fallback.** A primary run that fails *after* creating the Doc
leaves a duplicate Doc behind when the fallback runs. Known and accepted (DESIGN.md §4);
`durable: true` on the tool prevents this *within* a single run, not across two processes.

**A dependency or the model itself.** The run installs npm dependencies and sends data to a
third-party model provider. A malicious dependency in a job holding these credentials is
game over; `npm ci` against a committed lockfile and pinned action SHAs are the mitigation,
and they are not complete. The model provider sees the issue text and the repository content
the model reads.
