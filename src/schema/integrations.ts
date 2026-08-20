import * as v from 'valibot';

/**
 * Input schemas for the three integrations. The model never calls these functions — they
 * are invoked from TypeScript in the publish tool — but they still validate at the egress
 * boundary. The values flowing through them are partly model-generated, and a boundary
 * that only validates when someone remembers to is not a boundary.
 */

export const IssueRefSchema = v.strictObject({
  owner: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]+$/)),
  repo: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]+$/)),
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type IssueRef = v.InferOutput<typeof IssueRefSchema>;

export const CreateDocInputSchema = v.strictObject({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
  markdown: v.pipe(v.string(), v.minLength(1), v.maxLength(400_000)),
  folderId: v.pipe(v.string(), v.minLength(1)),
});
export type CreateDocInput = v.InferOutput<typeof CreateDocInputSchema>;

export const CreatedDocSchema = v.strictObject({
  id: v.string(),
  url: v.pipe(v.string(), v.url()),
});
export type CreatedDoc = v.InferOutput<typeof CreatedDocSchema>;

export const DiscordPostInputSchema = v.strictObject({
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  issueTitle: v.pipe(v.string(), v.maxLength(300)),
  issueUrl: v.pipe(v.string(), v.url()),
  docUrl: v.pipe(v.string(), v.url()),
  summary: v.pipe(v.string(), v.maxLength(400)),
  severity: v.string(),
  injectionSuspected: v.boolean(),
});
export type DiscordPostInput = v.InferOutput<typeof DiscordPostInputSchema>;
