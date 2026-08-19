/**
 * Manual smoke test: Google Drive / Docs.
 *
 *   npm run smoke:docs
 *
 * Creates one real Google Doc in the configured folder, using the same
 * `createAnalysisDoc` the agent uses, and prints its URL.
 *
 * Deliberately NOT part of `npm test`. It needs real credentials and it leaves a real
 * artefact behind, so it must be a thing a human chooses to do, never something a test run
 * does on their behalf. `npm test` and `npm run verify` stay offline and credential-free.
 *
 * The one Drive failure everybody hits first is `storageQuotaExceeded`: a service account
 * has no Drive storage quota of its own, so GOOGLE_DRIVE_FOLDER_ID must name a folder on a
 * Shared Drive. See docs/secrets.md.
 */

import { createAnalysisDoc } from '../src/integrations/google-docs.ts';
import { googleDriveFolderId, googleServiceAccount } from '../src/env.ts';

const TITLE = `[SMOKE TEST] issue-analyst — ${new Date().toISOString()}`;

const MARKDOWN = [
  '# Smoke test',
  '',
  'This document was created by `npm run smoke:docs` to verify that the service account can',
  'create Docs in the configured folder. It contains no real analysis. Delete it.',
  '',
  '## Formatting check',
  '',
  'Drive converts the uploaded markdown server-side, so this section also confirms that',
  'headings, lists and tables survive the conversion:',
  '',
  '- a bullet',
  '- another bullet',
  '',
  '| Field | Value |',
  '| --- | --- |',
  '| kind | smoke test |',
  '| safe to delete | yes |',
].join('\n');

async function main(): Promise<void> {
  // Read config through src/env.ts, never process.env directly, so this script fails the
  // same way and with the same messages as a real run. Credential *values* are never
  // printed — not even truncated. Only the account identity, which is not a secret.
  const folderId = googleDriveFolderId();
  const { clientEmail } = googleServiceAccount();

  console.log('About to do the following:');
  console.log(`  create one Google Doc titled "${TITLE}"`);
  console.log(`  in Drive folder ${folderId}`);
  console.log(`  as service account ${clientEmail}`);
  console.log(`  containing ${MARKDOWN.length} characters of placeholder markdown`);
  console.log('');

  const doc = await createAnalysisDoc({ title: TITLE, markdown: MARKDOWN, folderId });

  console.log(`PASS: created Doc ${doc.id}`);
  console.log(`  ${doc.url}`);
  console.log('');
  console.log('ACTION REQUIRED: this is a real Doc in a real folder. Open the URL above and');
  console.log('delete it — smoke-test documents accumulating in the analysis folder are');
  console.log('noise a maintainer will eventually have to wade through.');
}

main().catch((error: unknown) => {
  console.error('FAIL: could not create the Doc.');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error('If the message mentions storageQuotaExceeded, the folder is not on a Shared');
  console.error('Drive. If it is a 403 or 404, the folder is not shared with the service');
  console.error('account as Content manager. See docs/secrets.md.');
  process.exitCode = 1;
});
