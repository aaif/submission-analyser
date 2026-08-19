/**
 * Environment save/restore for tests.
 *
 * Every test in this suite must run with no real credentials present, and must not leak the
 * variables it sets into the next test. `withEnv` snapshots the whole of `process.env`,
 * applies an overlay, and restores the snapshot afterwards.
 */

export type EnvOverlay = Record<string, string | undefined>;

export function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

export function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function applyEnv(overlay: EnvOverlay): void {
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Every credential-bearing variable this project reads, cleared. Tests that need one supply
 * an obviously-fake value explicitly, so nothing can silently depend on a developer's real
 * environment.
 */
export const NO_CREDENTIALS: EnvOverlay = {
  GITHUB_TOKEN: undefined,
  GH_TOKEN: undefined,
  GOOGLE_SERVICE_ACCOUNT_JSON: undefined,
  GOOGLE_DRIVE_FOLDER_ID: undefined,
  DISCORD_WEBHOOK_URL: undefined,
  COPILOT_GITHUB_TOKEN: undefined,
  GEMINI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  GITHUB_REPOSITORY: undefined,
  DRY_RUN: undefined,
  FLUE_FAUX: undefined,
  FLUE_MODEL: undefined,
};

/** The minimum a publish-tool run needs, all fake: faux model provider, no egress creds. */
export const FAUX_RUN_ENV: EnvOverlay = {
  ...NO_CREDENTIALS,
  FLUE_FAUX: '1',
  GITHUB_REPOSITORY: 'acme/widget',
  // Short on purpose: `knownSecretValues()` only treats values of >= 8 chars as secrets, so
  // this cannot make the egress secret scanner fire on unrelated text.
  GITHUB_TOKEN: 'faux',
};
