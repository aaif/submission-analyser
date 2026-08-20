# Reference corpus

Past hand-written analyses. The skill reads the frontmatter of every file here, picks the
3–5 most relevant to the issue under analysis, and reads those in full — so this directory
is what makes the agent's judgement specific to *this* project rather than generic.

## The files currently here are synthetic

`example-*.md` are **fabricated examples**, written to establish the format and to give the
retrieval step something to exercise before real history exists. Each carries
`example: true` in its frontmatter and a banner in its body. They describe a fictional
service and no real incident.

**Replace them with real analyses as soon as you have any**, and delete the examples once
two or three real ones are in place. The agent is instructed not to cite examples as
precedent, but synthetic precedent is still a poor substitute for the real thing.

## Adding a real analysis

Copy the frontmatter block from any example, drop `example: true`, and write the body
against `../template.md`.

```yaml
---
issue-number: 412
date: 2026-03-14
issue-type: bug
severity: high
tags: [queue, retries, data-loss]
components: [src/queue/consumer.ts]
---
```

`tags` and `components` do the retrieval work — they are what the skill matches against, so
prefer the words a future reporter would actually use.

**Audit before committing.** These files are read into model context and their conclusions
are quoted into the published analysis and its Discord summary. Do not include customer
names, internal hostnames,
credentials, unannounced roadmap detail, or anything from a private security embargo.
