---
issue-number: 401
date: 2026-02-27
issue-type: security
severity: critical
tags: [logging, secrets, redaction, credentials, information-disclosure]
components: [src/http/client.ts, src/logging/serializer.ts]
example: true
---

> **SYNTHETIC EXAMPLE — not a real issue.** Written to illustrate the expected format and
> depth. The project, issue and incident described here are fictional.

# Analysis of issue #401: Authorization headers appear in debug logs

## Summary

A reporter running at `LOG_LEVEL=debug` found outbound request headers written verbatim to
stdout, including `Authorization: Bearer …` with an intact token. They included a redacted
excerpt. Any operator running at debug level has been shipping live credentials into
whatever aggregates their logs.

## Classification

- **Type:** security
- **Severity:** critical
- **Reproducibility:** reproducible

**Severity rationale.** Credential disclosure to a system with a different — usually much
broader — access model than the credential itself, and log aggregators retain and index for
months. Critical despite requiring debug level, because debug in production is common and
the blast radius is every token used while it was on.

## Affected components

- `src/http/client.ts` — logs the request object wholesale at debug level
- `src/logging/serializer.ts` — has a redaction list that this path does not use

## Root-cause hypotheses

1. **The redaction list exists but is bypassed.** `serializer.ts` redacts a set of key names,
   but `client.ts` calls `JSON.stringify(headers)` and logs the resulting string, so by the
   time the serializer sees it there is no structure left to redact. *Confirmed by:* the
   excerpt showing a JSON-stringified header blob rather than the serializer's usual
   key-value rendering.
2. **The list is missing `authorization`.** Ruled out by reading it — `authorization` is
   present. This is why the fix must not be "add it to the list".

## Suggested actions

1. Log the header object, not a pre-stringified copy, so the serializer can redact it. Fixes
   this instance.
2. **Then fix the class, not the instance.** Deny-listing key names fails the moment a new
   header, a nested body or a query string carries a credential. Add a test that asserts no
   log line produced by the HTTP client contains a known sentinel token, and default to
   logging header *names* only.
3. Advise operators who ran at debug level to rotate outbound credentials. This is the part
   that must not be forgotten — the code fix does not un-log anything.
4. Search for other `JSON.stringify` calls on request- or response-shaped objects.

## Open questions

- Which versions log this? Determines the rotation advisory's scope.
- Are response headers affected too? `Set-Cookie` would be equally bad.

## Related past reviews

- **example-queue-duplicate-delivery.md** — same lesson at a different seam: the buffered
  path bypassed the guarantee the direct path honoured. When a safety mechanism exists but a
  second code path routes around it, adding to the mechanism does not help; closing the
  bypass does.
