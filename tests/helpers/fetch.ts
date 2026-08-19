/**
 * A recording `fetchImpl` for the integration seams.
 *
 * Both `createAnalysisDoc` and `postToDiscord` take an injectable `fetchImpl`, so the
 * integration tests need no HTTP interceptor: the fake records the calls and returns a
 * canned `Response`. Nothing here can reach the network — if the seam were ever bypassed,
 * `expect(calls)` would be empty and the test would fail rather than silently dial out.
 */

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
  method: string | undefined;
  headers: Record<string, string>;
  /** The raw body as handed to fetch — a string for JSON posts, FormData for the upload. */
  body: BodyInit | null | undefined;
}

export interface RecordingFetch {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
}

function normalizeHeaders(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = init?.headers;
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  return out;
}

/**
 * @param responder Produces the `Response` for call n (0-based). A plain object is returned
 *   as a 200 JSON body.
 */
export function recordingFetch(
  responder: (call: RecordedCall, index: number) => Response | Promise<Response>,
): RecordingFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      init,
      method: init?.method,
      headers: normalizeHeaders(init),
      body: init?.body ?? null,
    };
    calls.push(call);
    return await responder(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(status: number, statusText: string, body = ''): Response {
  return new Response(body, { status, statusText });
}
