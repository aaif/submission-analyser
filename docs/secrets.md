# Secrets and configuration

Everything an operator needs to mint, in the order it is least painful to do it. The
authoritative list of variables is [`src/env.ts`](../src/env.ts); this document explains
where each value comes from.

> There is no `.env.example` in the repo. `src/env.ts` is the single list, it names every
> variable it requires in its error messages, and a second copy would only drift out of date.
> For local runs, set the variables your chosen provider needs and let the preflight check
> tell you what is missing — it fails before spending a token.

## What goes where

Repository **secrets** (Settings → Secrets and variables → Actions → Secrets). Masked in
logs, not readable after saving.

| Secret                        | Used by                             | Notes                                                  |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | publish (Doc creation)              | The whole key file, one line                           |
| `GOOGLE_DRIVE_FOLDER_ID`      | publish (Doc creation)              | Not sensitive in itself; kept a secret to avoid naming the folder publicly |
| `DISCORD_WEBHOOK_URL`         | publish (announcement)              | **Is itself a credential** — see below                 |

Note what is *not* in that table: there is no model credential. Model access comes from the
workflow's own `GITHUB_TOKEN` via `copilot-requests: write` — see §1.

Repository **variables** (same page → Variables). Visible in the UI and in logs, editable in
one click, which is exactly what you want mid-incident.

| Variable               | Default if unset                  | What it does                          |
| ---------------------- | --------------------------------- | ------------------------------------- |
| `PRIMARY_MODEL`        | `github-copilot/claude-opus-4.7`  | Model for the first attempt           |
| `FALLBACK_MODEL`       | `github-copilot/gpt-5.4`          | Model for the second attempt          |
| `CANARY_ISSUE_NUMBER`  | `1`                               | The fixed issue the daily canary analyses |
| `TARGET_REPOSITORY`    | *(the repo the workflow runs in)* | `owner/repo` whose issues get analysed |

`TARGET_REPOSITORY` is the one you are most likely to need. This agent is built to run from
its own tooling repository and analyse issues filed **elsewhere** — set it to e.g.
`aaif/project-proposals`. Leave it unset only if the analyst and the issues live in the same
repository. It is deliberately *not* inferred from `GITHUB_REPOSITORY`: a cross-repo run that
silently read the analyst repo's own issue #N would still create a Doc and still post to
Discord, having analysed entirely the wrong text. A dispatch may override it per run
(`target_repo` input), and the workflow's assert step fails the run if the analysis it
published does not name the repository that was dispatched.

`GITHUB_TOKEN` needs **no setup at all** *if* the issues live in the same repository as the
workflow. Actions mints one per run and the workflows pass it through as
`secrets.GITHUB_TOKEN`, with permissions from each workflow's `permissions:` block —
`contents: read` and nothing else. The agent has no write path to any repository at all: it
publishes a Doc and a Discord message and never posts back, so it needs no `issues: write`.

For a **cross-repository** setup that token is not enough: `secrets.GITHUB_TOKEN` is scoped
to the repository the workflow runs in and cannot read a different one. If the target repo is
public, any token that can read public repositories will do — the Copilot PAT from step 1
already qualifies, so setting `GITHUB_TOKEN` to that same value works. If the target repo is
private, mint a separate fine-grained PAT with **Contents: read** and **Issues: read** on the
target repository only, and store it as the `GITHUB_TOKEN` secret. Either way it needs no
write permission anywhere.

There is **one model credential**, because all model access goes through GitHub Copilot.
Copilot's catalog spans four vendors, so the fallback model comes from a different lab than the
primary without a second API key to provision, rotate, or leak. `src/env.ts` rejects any
`FLUE_MODEL` outside the `github-copilot` provider, so adding another vendor's key to this repo
would not silently start working — see [docs/models.md](models.md).

---

## 1. Model access — no secret needed

**There is nothing to mint here. Delete the `COPILOT_GITHUB_TOKEN` secret if you created one.**

Model access comes from the workflow's own `GITHUB_TOKEN`. A workflow that declares

```yaml
permissions:
  contents: read
  copilot-requests: write
```

gets a token carrying Copilot entitlement, with the requests billed to the organisation that
owns the repository. `copilot-requests: write` grants no repository write of any kind — it
authorises inference — so it leaves the read-only posture in
[docs/threat-model.md](threat-model.md) intact. Both workflows already declare it; the
workflows pass `secrets.GITHUB_TOKEN` through as `COPILOT_GITHUB_TOKEN`, which is the variable
name pi-ai reads.

Two org-level prerequisites, both one-time, both needing a Copilot admin rather than a token:

1. The org has Copilot (`aaif` does — that is where the seats and credits are).
2. The **"Allow use of Copilot CLI billed to the organization"** policy is enabled. It is on by
   default if the older "Copilot CLI" policy was. If the exchange returns 403 for a token you
   believe is fine, this switch is the first place to look.

### Why not a PAT — this cost three rounds

A fine-grained personal access token with the *Copilot Requests* permission **cannot reach a
Copilot model**, and that is not a configuration problem:

- The token exchange at `/copilot_internal/v2/token` answers **404** for one, while answering
  401 unauthenticated — so the route exists, the credential authenticates, and the exchange
  does not apply to it.
- Sent directly, all four `*.githubcopilot.com` hosts across three integration ids — twelve
  combinations, measured by `npm run probe:copilot` — answer `Personal Access Tokens are not
  supported for this endpoint`.

GitHub documents that PAT for the Copilot **CLI binary**, which is not the Copilot API this
project calls. If you followed an earlier version of this document and minted one, it was not
your mistake: the document was wrong. Remove it — a credential in a repository's secrets that
nothing can use is pure exposure.

Two related facts that earlier drafts got wrong, kept because they are the questions people
ask:

- **A seat is a licence assigned to a unique user account.** An org does not hold seats, it
  grants them to members. So *Copilot Requests* — an **account** permission — can never appear
  on an org-owned fine-grained token, which only offers repository and organisation
  permissions. Nothing is missing and no admin setting reveals it; it is structural.
- **Premium requests draw on the allowance attached to the seat.** With the Actions-token path
  the question is moot: spend lands on the org that owns the repository. Keep it bounded with
  the cost controls in [docs/models.md](models.md).

### Verifying it

`npm run probe:copilot` from a laptop cannot answer this, because the entitlement only exists
inside a workflow that requested the permission. Dispatch the **Probe Copilot access**
workflow instead (`workflow_dispatch`, read-only, invokes no model, charges nothing). Its first
line names the kind of credential in the environment — `ghs_` Actions token, `gho_` OAuth,
`github_pat_` PAT — which is the single fact worth checking before theorising about anything
else.

### If model calls fail

Do not start rotating credentials — there is no credential to rotate. Read
[docs/models.md](models.md), which has the ordered checklist: the permission, then the org
policy, then which credential is actually in the environment, then what the exchange said.

## 2. Google service account and Drive folder

This is the step with the traps. Read all three before clicking anything.

1. Google Cloud console → create (or pick) a project → **APIs & Services → Enable APIs** →
   enable the **Google Drive API**. The Docs API is not needed: the Doc is created by a
   single Drive `files.create` multipart upload that converts markdown server-side
   ([`src/integrations/google-docs.ts`](../src/integrations/google-docs.ts)).
2. **IAM & Admin → Service accounts → Create service account**. Name it something a human
   will recognise in a Drive sharing dialog, e.g. `issue-analyst`. Grant it **no project
   roles** — it needs none.
3. On the service account → **Keys → Add key → Create new key → JSON**. Download it.
4. Flatten the file to one line and store it as the `GOOGLE_SERVICE_ACCOUNT_JSON` secret.
   `jq -c . key.json | pbcopy` does the job. Keep the `\n` escapes inside `private_key`
   exactly as they are; `src/env.ts` requires `client_email` and a `private_key` containing
   `PRIVATE KEY`. Delete the downloaded file afterwards.
5. Create the destination folder **on a Shared Drive** (see trap 1), open it, and copy the id
   from the URL: `https://drive.google.com/drive/folders/<THIS>`. Store as
   `GOOGLE_DRIVE_FOLDER_ID`.
6. Share that folder with the service account's `client_email` as **Content manager**
   (Writer also works). The Doc inherits the folder's permissions; nothing in this codebase
   ever calls `permissions.create`.

### Trap 1 — a service account has no Drive storage quota

**This is the single most likely first-run failure.** A service account is not a user and
owns no Drive storage. A `files.create` into a My Drive folder therefore fails with
`storageQuotaExceeded`, no matter how the folder is shared, because the created file would
need an owner with quota.

The fix is the folder's location, not its permissions: the target folder must live on a
**Shared Drive**, where files are owned by the drive rather than by a user. Create a Shared
Drive, add the service account as a member (Content manager), and use a folder inside it.
`createAnalysisDoc` already sends `supportsAllDrives=true`, and it recognises this error and
says so — but only after a run has spent a model call, so get it right first.

### Trap 2 — scope

The code requests `https://www.googleapis.com/auth/drive.file`, the narrowest scope that
works: access to files this service account created, and to files a user explicitly shared
with it. That is sufficient for creating a Doc inside a shared folder.

If `files.create` returns 403/404 against a **pre-existing** parent folder that was created
by someone else, the scope may need widening to `https://www.googleapis.com/auth/drive`.
Prefer the alternative first: create a *new* folder and share it with the service account.
Widening to full `drive` gives this key read access to everything the account can see, which
is a much larger blast radius for a token that lives in CI.

### Trap 3 — never grant link-anyone sharing

Do **not** set the folder (or any Doc in it) to "Anyone with the link". The Doc URL is posted
into a Discord channel, and the issues being analysed may well be in a public repository, so
a link-anyone grant makes every analysis world-readable — including analyses of security reports, which is
the worst case in this system.

Access must come from **folder inheritance**, to people who are already trusted with the
repository: share the folder (or the Shared Drive) with the maintainers' group. People who
should not read the analysis then get a permissions page instead of the analysis, which is
the correct outcome even though it will occasionally annoy someone.

## 3. Discord webhook (`DISCORD_WEBHOOK_URL`)

1. In Discord: **Channel → Edit Channel → Integrations → Webhooks → New Webhook**.
2. Name it something identifiable (`Issue Analysis`), pick the announcement channel, and
   **Copy Webhook URL**.
3. Store it as the `DISCORD_WEBHOOK_URL` secret.

**The URL is itself a credential.** Its path contains the webhook token, so anyone holding
it can post to that channel under the webhook's identity, indefinitely, with no further
authentication. It is a secret, never a variable, it never belongs in a log line or an error
message, and `src/env.ts` is written so that no failure path echoes it. If it leaks,
regenerate the webhook — that invalidates the old URL immediately.

The agent posts with `allowed_mentions: { parse: [] }`, so an analysis derived from an issue
body saying "please ping @everyone" cannot ping anyone. Do not remove that.

## 4. Dispatch token, for a cross-repository setup (`ANALYST_DISPATCH_TOKEN`)

Skip this section entirely if the analyst and the issues live in the same repository.

A workflow's `on: issues` trigger only ever fires for the repository hosting the workflow, so
"analyse issues filed in another repo" cannot be done from this repo alone. The target repo
needs one small workflow that asks this repo to run. Copy
[`examples/target-repo-dispatch.yml`](../examples/target-repo-dispatch.yml) into the target
repository as `.github/workflows/request-issue-analysis.yml` and edit the owner/repo
constants at the top.

That dispatcher needs a token that can start a workflow in *this* repository, which the
target repo's own `GITHUB_TOKEN` cannot do:

1. https://github.com/settings/personal-access-tokens → **Generate new token** (fine-grained).
2. Resource owner: the org that owns this analyst repo. Repository access: **Only select
   repositories** → this repo (e.g. `aaif/flue-issue-analyst`) and nothing else.
3. Repository permissions → **Actions**: *Read and write*. Grant **nothing** else.
4. Store it as the `ANALYST_DISPATCH_TOKEN` secret in the **target** repository.

**Actions: write only.** It is tempting to reach for `repository_dispatch` instead, which
looks like the more idiomatic trigger — but dispatching a `repository_dispatch` event
requires **Contents: write** on the target, and Contents: write is a push. A push into this
repository rewrites the very workflow that holds the Copilot PAT, the service-account key and
the Discord webhook, which makes it arbitrary code execution with every secret this project
has. `workflow_dispatch` needs only Actions: write, which can start a workflow but cannot
change one. That is why the workflow here is `workflow_dispatch`-only, and it is also why the
manual and automatic paths are the same single file rather than two that can drift apart.

Note that a token held in the *target* repo can trigger analyst runs at will. Keep that repo's
write access to people you would trust with a model budget.

## 5. Verify, before trusting it with a real issue

```bash
npm run verify                          # offline: format, types, tests, skill validation
npm run smoke:docs                      # creates one real Doc — then delete it
npm run smoke:discord                   # posts one marked test message
npm run smoke:github -- 1               # read issue #1 of TARGET_REPOSITORY
```

`smoke:github` is read-only; there is no write variant, because the agent has no write path.
Run it with `TARGET_REPOSITORY` set to the real target — proving the token can read the
*target* repo is a different question from whether it can read the repo it runs in, and the
first is the one that breaks.

Then run the **Issue analyst** workflow by hand (Actions → Run workflow) with an issue number
and `dry_run` checked: a full real run, real model, real issue, publishing nothing. If that is
green, run it again unchecked. Only then wire up the dispatcher in step 4.

## Rotation

- **Dispatch PAT** — expires like any fine-grained PAT. When it does, issues stop being
  analysed **silently**: the dispatcher step fails in the target repo, not here, so nothing in
  this repo turns red. If that matters, watch the target repo's Actions tab, or shorten the
  gap by giving the token a calendar reminder.
- **Copilot PAT** — expires by design. The daily canary catches it the next morning.
- **Service-account key** — create the new key, update the secret, then delete the old key
  in the console. Both are valid simultaneously, so there is no gap to plan around.
- **Discord webhook** — regenerating in the Discord UI invalidates the old URL instantly.
  Update the secret first if you want to avoid a red run in between.
