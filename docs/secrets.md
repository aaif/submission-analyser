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
| `COPILOT_GITHUB_TOKEN`        | primary model leg only              | Copilot-scoped fine-grained PAT                        |
| `GEMINI_API_KEY`              | fallback model leg only             | AI Studio API key                                      |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | publish (Doc creation)              | The whole key file, one line                           |
| `GOOGLE_DRIVE_FOLDER_ID`      | publish (Doc creation)              | Not sensitive in itself; kept a secret to avoid naming the folder publicly |
| `DISCORD_WEBHOOK_URL`         | publish (announcement)              | **Is itself a credential** — see below                 |

Repository **variables** (same page → Variables). Visible in the UI and in logs, editable in
one click, which is exactly what you want mid-incident.

| Variable               | Default if unset                  | What it does                          |
| ---------------------- | --------------------------------- | ------------------------------------- |
| `PRIMARY_MODEL`        | `github-copilot/claude-opus-4.7`  | Model for the first attempt           |
| `FALLBACK_MODEL`       | `google/gemini-2.5-pro`           | Model for the second attempt          |
| `CANARY_ISSUE_NUMBER`  | `1`                               | The fixed issue the daily canary analyses |

`GITHUB_TOKEN` needs **no setup at all**. GitHub Actions mints one per run and the workflows
pass it through as `secrets.GITHUB_TOKEN`. Its permissions come from the `permissions:` block
in each workflow — `contents: read` and `issues: write`, never more. You only ever set
`GITHUB_TOKEN` (or `GH_TOKEN`) by hand for local runs.

The model credentials are handed out **asymmetrically**: the primary step receives
`COPILOT_GITHUB_TOKEN` and not `GEMINI_API_KEY`; the fallback step receives the reverse. Each
leg gets exactly the one credential it can use. Keep it that way.

---

## 1. Copilot PAT (`COPILOT_GITHUB_TOKEN`)

The `github-copilot` provider authenticates with a GitHub PAT belonging to an account that
has a Copilot entitlement.

1. Confirm the account has Copilot access. Org-assigned seats count; check with the org
   admin if unsure, because a token from an account with no entitlement fails at the first
   model request, not at registration.
2. https://github.com/settings/personal-access-tokens → **Generate new token** (fine-grained).
3. Resource owner: your own account. Repository access: **Public repositories (read-only)** is
   enough — this token is for model access, not repository access.
4. Account permissions → **Copilot Requests**: *Read and write*. Grant nothing else.
5. Expiry: 90 days or less. Put the renewal date in a calendar; the daily canary will tell
   you when you have forgotten, but a calendar entry is cheaper than a red Tuesday.
6. Save the value as the `COPILOT_GITHUB_TOKEN` secret.

If model calls come back **401 or 404**, do not start rotating tokens: read
[docs/models.md](models.md) first. The built-in provider points at the *individual* Copilot
endpoint, and a business or enterprise entitlement needs a different host. That is a
one-line config override, and it is the more likely explanation.

## 2. Gemini API key (`GEMINI_API_KEY`)

1. https://aistudio.google.com/apikey → **Create API key**.
2. Attach it to a project with billing configured if you want more than the free tier's rate
   limits; the fallback only runs when the primary is already down, so free-tier limits are
   usually survivable, but the canary exercises it daily too.
3. Save as the `GEMINI_API_KEY` secret.

This is a *different* Google credential from the service account in step 3. The API key talks
to Gemini; the service account talks to Drive. They are not interchangeable.

## 3. Google service account and Drive folder

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
into a Discord channel and commented on an issue that may well be public, so a link-anyone
grant makes every analysis world-readable — including analyses of security reports, which is
the worst case in this system.

Access must come from **folder inheritance**, to people who are already trusted with the
repository: share the folder (or the Shared Drive) with the maintainers' group. People who
should not read the analysis then get a permissions page instead of the analysis, which is
the correct outcome even though it will occasionally annoy someone.

## 4. Discord webhook (`DISCORD_WEBHOOK_URL`)

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

## 5. Verify, before trusting it with a real issue

```bash
npm run verify                          # offline: format, types, tests, skill validation
npm run smoke:docs                      # creates one real Doc — then delete it
npm run smoke:discord                   # posts one marked test message
npm run smoke:github -- 1               # dry read of issue #1
npm run smoke:github -- 1 --comment     # only against an issue you own
```

Then run the **Issue analyst (manual)** workflow with `dry_run` checked: a full real run,
real model, real issue, publishing nothing. If that is green, run it again unchecked.

## Rotation

- **Copilot PAT** — expires by design. The daily canary catches it the next morning.
- **Gemini key** — rotate on the same cadence as the PAT.
- **Service-account key** — create the new key, update the secret, then delete the old key
  in the console. Both are valid simultaneously, so there is no gap to plan around.
- **Discord webhook** — regenerating in the Discord UI invalidates the old URL instantly.
  Update the secret first if you want to avoid a red run in between.
