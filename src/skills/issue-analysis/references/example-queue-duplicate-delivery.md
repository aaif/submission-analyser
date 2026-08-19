---
issue-number: 412
date: 2026-03-14
issue-type: bug
severity: high
tags: [queue, retries, idempotency, data-loss, duplicate-delivery]
components: [src/queue/consumer.ts, src/queue/ack.ts]
example: true
---

> **SYNTHETIC EXAMPLE — not a real issue.** Written to illustrate the expected format and
> depth. The project, issue and incident described here are fictional.

# Analysis of issue #412: Duplicate webhook deliveries after consumer restart

## Summary

A user reports that restarting the queue consumer causes some webhooks to be delivered
twice, observed as duplicate downstream records rather than duplicate log lines. They
supplied a reproduction: enqueue 100 jobs, `SIGTERM` the consumer mid-batch, restart, and
count deliveries. On three of five attempts they saw between one and four duplicates,
always for jobs that were in flight at shutdown.

## Classification

- **Type:** bug
- **Severity:** high
- **Reproducibility:** reproducible

**Severity rationale.** Duplicate delivery corrupts downstream state for any consumer that
is not itself idempotent, and we document at-most-once delivery. It is high rather than
critical because the window is bounded to in-flight jobs at shutdown and no data is lost —
only duplicated.

## Affected components

- `src/queue/consumer.ts` — the shutdown path
- `src/queue/ack.ts` — acknowledgement batching

## Root-cause hypotheses

1. **Acknowledgements are batched but delivery is not, and shutdown does not flush the
   batch.** `ack.ts` buffers acks and flushes every 500ms or 50 messages, whichever comes
   first. The `SIGTERM` handler in `consumer.ts` stops the poll loop and exits without
   awaiting a final flush, so a delivered-but-unacked job is redelivered on restart. This
   fits the evidence exactly: duplicates only for in-flight jobs, and a count in the low
   single digits matching the un-flushed buffer. *Confirmed by:* logging buffer depth at
   shutdown, or setting the flush interval to 0 and seeing duplicates disappear.
2. **Visibility timeout expiring during a slow handler.** Would also produce duplicates, but
   should occur during steady-state operation too, and the reporter sees them only at
   restart. *Refuted unless* they can reproduce without a restart.

Hypothesis 1 accounts for all the reported evidence; 2 is retained only because both could
be true.

## Suggested actions

1. Await a final `flushAcks()` in the `SIGTERM`/`SIGINT` handler in `src/queue/consumer.ts`,
   with a bounded timeout so shutdown cannot hang.
2. Add a test that asserts the ack buffer is empty after `shutdown()` resolves. The bug is a
   missing await, so only a test at that seam will catch its regression.
3. Ask the reporter to confirm whether duplicates ever occur *without* a restart — that
   settles hypothesis 2 and costs them one run.
4. Consider documenting at-least-once as the honest guarantee. Even with the flush fixed, a
   hard kill can still redeliver.

## Open questions

- Does the duplication occur on `SIGKILL` only, or also on a graceful shutdown?
- What is the configured visibility timeout, and how long does their handler take?

## Related past reviews

None; this was the first analysis in this area.
