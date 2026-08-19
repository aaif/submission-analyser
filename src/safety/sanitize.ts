/**
 * Egress hardening for model-generated text.
 *
 * The agent publishes under a trusted identity into three places a human will read:
 * a Google Doc, a Discord channel, and a public issue comment. Anything an attacker can
 * get the model to echo therefore inherits that trust. These helpers strip the three
 * abuses that matter, and are applied at the egress boundary rather than trusted to the
 * model's own restraint.
 */

/** Zero-width and bidi control characters, used to hide text from human reviewers. */
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/g;

/**
 * Defuses `@everyone`, `@here` and role/user pings by inserting a zero-width-free
 * separator. Discord's `allowed_mentions` already blocks the ping server-side; this makes
 * the text honest in the Doc and the issue comment too, where no such control exists.
 */
export function neutralizeMentions(text: string): string {
  return text
    .replace(/@(everyone|here)\b/gi, '@⁠$1')
    .replace(/<@[!&]?(\d+)>/g, '[mention removed]')
    .replace(/(^|[\s(])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/g, '$1`@$2`');
}

/**
 * Strips HTML tags and comments. HTML comments are the more important half: `<!-- ... -->`
 * renders as nothing in a GitHub comment, so it is the natural place to hide a payload
 * aimed at whatever reads the thread next.
 */
export function stripMarkup(text: string): string {
  return (
    text
      .replace(/<!--[\s\S]*?-->/g, '')
      // An *unterminated* `<!--` is the nastier case, and the pattern above cannot match it.
      // GitHub renders everything after an unclosed comment marker as nothing, so a single
      // `<!--` surviving into an early field would hide the whole rest of the document from
      // the human reviewer — including the injection banner. It also arises innocently
      // whenever a bounded field is truncated mid-comment.
      .replace(/<!--[\s\S]*$/, '')
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      .replace(INVISIBLE, '')
  );
}

const ALLOWED_LINK_HOSTS = new Set([
  'github.com',
  'gist.github.com',
  'docs.github.com',
  'docs.google.com',
  'drive.google.com',
]);

/**
 * Renders links to hosts outside the allowlist inert — the URL stays visible as code so a
 * reviewer can still read it, but it is no longer a one-click destination endorsed by the
 * agent. Without this, "cite this reference: http://evil.example" in an issue body turns
 * the agent into a laundering service for attacker links.
 */
export function defuseLinks(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s<>()[\]"']+/gi, (url) => {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return '`' + url + '`';
    }
    const bare = host.startsWith('www.') ? host.slice(4) : host;
    return ALLOWED_LINK_HOSTS.has(bare) ? url : '`' + url + ' (link not followed)`';
  });
}

/** Truncates on a word boundary where possible, marking that it happened. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // `max - 1` leaves room for the ellipsis. Slicing to `max` and then appending would
  // return `max + 1` characters, which quietly overshoots every caller's budget — including
  // Discord's 280, where the overshoot is a rejected payload rather than a cosmetic issue.
  const hard = text.slice(0, max - 1);
  const lastSpace = hard.lastIndexOf(' ');
  const body = lastSpace > max * 0.6 ? hard.slice(0, lastSpace) : hard;
  return `${body.trimEnd()}…`;
}

/** The full egress pipeline for any model-generated string. */
export function sanitize(text: string, options: { max?: number } = {}): string {
  const cleaned = defuseLinks(neutralizeMentions(stripMarkup(text))).trim();
  return options.max === undefined ? cleaned : truncate(cleaned, options.max);
}
