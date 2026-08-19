/**
 * Manual smoke test: GitHub read, and optionally the comment write.
 *
 *   npm run smoke:github -- 123            # dry read only, the default
 *   npm run smoke:github -- 123 --comment  # also posts a marked test comment
 *
 * Uses the same `fetchIssue` / `commentOnIssue` the agent uses, against the repository named
 * by GITHUB_REPOSITORY.
 *
 * Reading is the default and commenting requires the explicit `--comment` flag, because a
 * smoke test that surprises a real issue thread with a comment — visible to the reporter, in
 * the maintainers' notifications, possibly on a public repo — is worse than no smoke test.
 * If you do pass `--comment`, point it at an issue you own.
 *
 * Deliberately NOT part of `npm test`: it needs a real token and touches a real repository.
 */

import { commentOnIssue, fetchIssue } from '../src/integrations/github.ts';
import { githubRepo, githubToken } from '../src/env.ts';

function parseArgs(argv: string[]): { issueNumber: number; comment: boolean } {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flags = argv.filter((arg) => arg.startsWith('--'));

  const unknown = flags.filter((flag) => flag !== '--comment');
  if (unknown.length > 0) {
    throw new Error(`Unknown flag(s): ${unknown.join(', ')}. Only --comment is supported.`);
  }

  const raw = positional[0];
  if (raw === undefined) {
    throw new Error('Usage: npm run smoke:github -- <issue-number> [--comment]');
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Issue number must be digits only, got "${raw}".`);
  }
  const issueNumber = Number.parseInt(raw, 10);
  if (issueNumber < 1) throw new Error('Issue number must be 1 or greater.');

  return { issueNumber, comment: flags.includes('--comment') };
}

async function main(): Promise<void> {
  const { issueNumber, comment } = parseArgs(process.argv.slice(2));

  // Config comes from src/env.ts so this script fails exactly as a real run would. The token
  // is required here only to fail fast on a missing one; its value is never printed.
  const { owner, repo } = githubRepo();
  githubToken();

  console.log('About to do the following:');
  console.log(`  fetch issue #${issueNumber} from ${owner}/${repo} (read only)`);
  if (comment) {
    console.log('  then POST one comment to that issue, clearly marked as a smoke test');
    console.log('  --- this is a real, visible write to a real issue thread ---');
  } else {
    console.log('  and nothing else: no comment will be posted (pass --comment to write one)');
  }
  console.log('');

  const issue = await fetchIssue({ owner, repo, issueNumber });

  console.log(`PASS (read): #${issue.number} "${issue.title}"`);
  console.log(`  author ${issue.author} (${issue.authorAssociation}), bot: ${issue.isBot}`);
  console.log(`  state ${issue.state}, opened ${issue.createdAt}`);
  console.log(`  labels: ${issue.labels.length > 0 ? issue.labels.join(', ') : '(none)'}`);
  console.log(`  body ${issue.body.length} chars, ${issue.comments.length} comment(s)`);
  console.log(`  truncated by the ingest limits: ${issue.truncated}`);
  console.log(`  ${issue.url}`);

  if (!comment) {
    console.log('');
    console.log('Comment write not attempted (no --comment). Read path verified.');
    return;
  }

  const body = [
    '**[SMOKE TEST]** Comment posted by `npm run smoke:github -- --comment` to verify that',
    'the token can write to issues. This is not an analysis and there is nothing to act on.',
    'Safe to delete.',
  ].join(' ');

  const posted = await commentOnIssue({ owner, repo, issueNumber, body });

  console.log('');
  console.log('PASS (comment): posted.');
  console.log(`  ${posted.url}`);
  console.log('Delete that comment when you are done with it.');
}

main().catch((error: unknown) => {
  console.error('FAIL: the GitHub smoke test did not complete.');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error('A 404 on a repo you can see in the browser usually means the token lacks access');
  console.error('rather than that the issue is missing; a 403 on the comment means the token has');
  console.error('no issues:write. See docs/secrets.md.');
  process.exitCode = 1;
});
