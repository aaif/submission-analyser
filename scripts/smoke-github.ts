/**
 * Manual smoke test: the GitHub read path.
 *
 *   npm run smoke:github -- 123
 *
 * Uses the same `fetchIssue` the agent uses, against the repository named by
 * TARGET_REPOSITORY (falling back to GITHUB_REPOSITORY). Read is the whole surface — the
 * agent has no write path to a repository, so there is nothing else here to smoke-test.
 *
 * The most useful thing this proves for a cross-repository setup is that the token can read
 * the *target* repo, which is a different question from whether it can read the repo the
 * workflow runs in.
 *
 * Deliberately NOT part of `npm test`: it needs a real token and touches a real repository.
 */

import { fetchIssue } from '../src/integrations/github.ts';
import { targetRepo, githubToken } from '../src/env.ts';

function parseArgs(argv: string[]): { issueNumber: number } {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flags = argv.filter((arg) => arg.startsWith('--'));

  if (flags.length > 0) {
    throw new Error(`Unknown flag(s): ${flags.join(', ')}. This script takes no flags.`);
  }

  const raw = positional[0];
  if (raw === undefined) {
    throw new Error('Usage: npm run smoke:github -- <issue-number>');
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Issue number must be digits only, got "${raw}".`);
  }
  const issueNumber = Number.parseInt(raw, 10);
  if (issueNumber < 1) throw new Error('Issue number must be 1 or greater.');

  return { issueNumber };
}

async function main(): Promise<void> {
  const { issueNumber } = parseArgs(process.argv.slice(2));

  // Config comes from src/env.ts so this script fails exactly as a real run would. The token
  // is required here only to fail fast on a missing one; its value is never printed.
  const { owner, repo } = targetRepo();
  githubToken();

  console.log(`Fetching issue #${issueNumber} from ${owner}/${repo} (read only).`);
  console.log('');

  const issue = await fetchIssue({ owner, repo, issueNumber });

  console.log(`PASS: #${issue.number} "${issue.title}"`);
  console.log(`  author ${issue.author} (${issue.authorAssociation}), bot: ${issue.isBot}`);
  console.log(`  state ${issue.state}, opened ${issue.createdAt}`);
  console.log(`  labels: ${issue.labels.length > 0 ? issue.labels.join(', ') : '(none)'}`);
  console.log(`  body ${issue.body.length} chars, ${issue.comments.length} comment(s)`);
  console.log(`  truncated by the ingest limits: ${issue.truncated}`);
  console.log(`  ${issue.url}`);
}

main().catch((error: unknown) => {
  console.error('FAIL: the GitHub smoke test did not complete.');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error('A 404 on a repo you can see in the browser usually means the token lacks access');
  console.error('rather than that the issue is missing. Check TARGET_REPOSITORY names the repo');
  console.error('you meant. See docs/secrets.md.');
  process.exitCode = 1;
});
