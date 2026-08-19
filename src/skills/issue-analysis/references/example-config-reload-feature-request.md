---
issue-number: 388
date: 2026-02-02
issue-type: feature-request
severity: low
tags: [configuration, hot-reload, operations, developer-experience]
components: [src/config/loader.ts]
example: true
---

> **SYNTHETIC EXAMPLE — not a real issue.** Written to illustrate the expected format and
> depth. The project, issue and incident described here are fictional.

# Analysis of issue #388: Reload configuration without restarting the process

## Summary

The reporter runs the service in an environment where a restart drops in-flight work, and
asks for configuration to be re-read on `SIGHUP` instead. They are specifically after log
level and rate-limit values; they explicitly say they do not need connection strings to be
reloadable.

## Classification

- **Type:** feature-request
- **Severity:** low
- **Reproducibility:** not-applicable

**Severity rationale.** No user is broken — a documented restart accomplishes the same
thing. It is a genuine operational improvement rather than a defect, and the reporter has a
workaround today.

## Affected components

- `src/config/loader.ts` — currently reads once at module load and freezes the result

## Root-cause hypotheses

Not a defect, so not applicable. The relevant design fact: `loader.ts` exports a frozen
object captured at import time, and callers destructure it at their own module load. Even
with a reload, existing holders would keep the old values — so the request cannot be
satisfied by re-reading the file alone. It needs an accessor (`getConfig().logLevel`) rather
than a snapshot, which is a change at every call site.

## Suggested actions

1. Scope it to the two values actually asked for. A general hot-reload of everything invites
   the question of what happens to an open connection pool when its DSN changes; log level
   and rate limits have no such problem.
2. Convert those two to accessor reads, leave the rest frozen at load, and say so in the
   docs. The split is the design, not a compromise.
3. Ask whether `SIGHUP` is required specifically, or whether polling the file's mtime would
   do — the latter also works in environments where signalling the process is awkward.

## Open questions

- Which deployment environment? It determines whether `SIGHUP` is even deliverable.
- Would a documented zero-downtime restart solve the underlying problem more cheaply?

## Related past reviews

None relevant.
