/**
 * Manual smoke test: Discord webhook.
 *
 *   npm run smoke:discord
 *
 * Posts one visibly-marked test message to the configured channel, through the same
 * `postToDiscord` the agent uses.
 *
 * Deliberately NOT part of `npm test`: it needs a real webhook and it posts to a real
 * channel where real people are reading. `npm test` and `npm run verify` stay offline.
 *
 * The message is marked as a test in the title, the summary and the footer field, because
 * the most annoying possible outcome of this script is a colleague reading a smoke test as a
 * genuine severity-critical analysis.
 */

import { postToDiscord } from '../src/integrations/discord.ts';
import { discordWebhookUrl } from '../src/env.ts';

async function main(): Promise<void> {
  // Validates shape (https, discord.com host, /api/webhooks/ path) and throws with a message
  // that names only the variable. The URL is itself a credential — its path contains the
  // webhook token — so it is never printed, in whole or in part.
  const url = discordWebhookUrl();
  const host = new URL(url).hostname;

  console.log('About to do the following:');
  console.log(
    `  POST one test embed to the webhook configured in DISCORD_WEBHOOK_URL (host ${host})`,
  );
  console.log('  clearly marked as a smoke test, with mentions suppressed');
  console.log('  visible to everyone in that channel');
  console.log('');

  await postToDiscord({
    issueNumber: 1,
    issueTitle: '[SMOKE TEST] ignore this message',
    issueUrl: 'https://github.com/octocat/Hello-World/issues/1',
    docUrl: 'https://docs.google.com/document/d/SMOKE_TEST_PLACEHOLDER/edit',
    summary:
      'Smoke test from npm run smoke:discord. Not a real analysis — no issue was analysed ' +
      'and the Doc link above is a placeholder. Nothing to act on.',
    severity: 'informational',
    injectionSuspected: false,
  });

  console.log('PASS: Discord accepted the webhook POST.');
  console.log('Check the channel: you should see one embed titled "#1 — [SMOKE TEST] ignore');
  console.log('this message". Delete it if your channel is one people actually read.');
}

main().catch((error: unknown) => {
  console.error('FAIL: the Discord webhook POST did not succeed.');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error('A 401 or 404 usually means the webhook was deleted or regenerated — mint a new');
  console.error('one and update the DISCORD_WEBHOOK_URL secret. See docs/secrets.md.');
  process.exitCode = 1;
});
