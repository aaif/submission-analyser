#!/usr/bin/env bash
#
# Exercises the useAgentFinish guard end to end, with no credentials.
#
# This script exists because the guard cannot be unit-tested: plain Vitest cannot import a
# module that imports SKILL.md, and the agent module does (documented Flue behaviour, not a
# config problem). The guard is a security control — it is what turns "the run followed
# instructions from the issue body" from a silent event into a red workflow run — so leaving
# its two throw branches unasserted would mean the only evidence they work is that they were
# written down.
#
# Each scenario asserts an exit code, because that is what CI actually reads.
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0

run() {
  local scenario="$1" want="$2" desc="$3"
  rm -rf node_modules/.cache/flue
  local out
  out=$(FLUE_FAUX=1 FLUE_FAUX_SCENARIO="$scenario" \
        GITHUB_REPOSITORY=acme/widget GITHUB_TOKEN=faux \
        npx flue run src/agents/issue-analyst.ts --id 1 --message 'Analyse issue #1' --json 2>&1)
  local got=$?
  if [ "$got" -eq "$want" ]; then
    printf '  ok   %-12s %s\n' "$scenario" "$desc"
    pass=$((pass + 1))
  else
    printf '  FAIL %-12s %s (wanted exit %s, got %s)\n' "$scenario" "$desc" "$want" "$got"
    printf '%s\n' "$out" | sed 's/^/       | /' | head -30
    fail=$((fail + 1))
  fi
}

echo 'finish-guard scenarios (faux provider, no credentials):'
run publish     0 'publishes and completes'
run no-tool     1 'nudged once, then fails rather than looping'
run rogue-tool  1 'unexpected tool aborts the run'

rm -rf node_modules/.cache/flue
echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
