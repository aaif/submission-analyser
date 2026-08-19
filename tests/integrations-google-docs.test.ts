/**
 * src/integrations/google-docs.ts — the Drive boundary.
 *
 * Everything here goes through the injected `fetchImpl`. The multipart body is still asserted
 * at wire level: the integration hands fetch a `FormData`, so the recorded `(url, init)` pair
 * is re-serialized through a `Request` (see `materialize` in tests/helpers/fetch.ts), which
 * runs the very same undici serializer fetch would. msw was tried first and rejected — it
 * adds an interceptor and a `localStorage` dependency to produce the identical bytes.
 *
 * The single most important assertion in this file is the negative one: `permissions.create`
 * is never called. The Doc URL is posted into a public issue comment and announced in
 * Discord, so a link-anyone grant would publish the analysis to the world.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRIVE_SCOPE, SOURCE_MIME, createAnalysisDoc } from '../src/integrations/google-docs.ts';
import { NO_CREDENTIALS, applyEnv, restoreEnv, snapshotEnv } from './helpers/env.ts';
import {
  errorResponse,
  jsonResponse,
  materialize,
  recordingFetch,
  type RecordedCall,
} from './helpers/fetch.ts';

/**
 * The target mimeType. `GOOGLE_DOC_MIME` is module-private in the integration (unlike
 * `DRIVE_SCOPE` and `SOURCE_MIME`), so the literal is restated here — the point of the
 * assertion is that the wire carries this exact string.
 */
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const ACCESS_TOKEN = 'ya29.test-access-token-not-a-real-credential';

const INPUT = {
  title: 'Analysis of issue #7',
  markdown: '# Analysis\n\nThe consumer redelivers in-flight jobs after a restart.',
  folderId: 'test-shared-drive-folder-id',
};

const CREATED = {
  id: 'created-doc-id',
  webViewLink: 'https://docs.google.com/document/d/created-doc-id/edit',
};

/** Runs a successful upload and returns the recorded calls plus the serialized request. */
async function upload(): Promise<{
  calls: RecordedCall[];
  contentType: string | null;
  body: string;
  boundary: string | undefined;
}> {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(CREATED));
  await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN, fetchImpl });
  expect(calls).toHaveLength(1);
  const { contentType, body } = await materialize(calls[0]!);
  const boundary = /boundary=(?<quote>"?)(?<boundary>[^";]+)\k<quote>/.exec(contentType ?? '')
    ?.groups?.boundary;
  return { calls, contentType, body, boundary };
}

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = snapshotEnv();
  // No Google credentials at all: an `accessToken` is always injected, so a code path that
  // tried to mint a real token would fail loudly rather than pick up a developer's key.
  applyEnv(NO_CREDENTIALS);
});

afterEach(() => restoreEnv(envSnapshot));

describe('createAnalysisDoc — the request on the wire', () => {
  it('scope is drive.file — access to files this service account created, nothing else', () => {
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('is a single files.create multipart upload with the expected query parameters', async () => {
    const { calls } = await upload();

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(UPLOAD_URL);
    expect(calls[0]!.method).toBe('POST');
    expect(url.searchParams.get('uploadType')).toBe('multipart');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('fields')).toBe('id,webViewLink');
    // The full query string, as a single readable assertion.
    expect(calls[0]!.url).toContain('uploadType=multipart');
    expect(calls[0]!.url).toContain('supportsAllDrives=true');
    expect(calls[0]!.url).toContain('fields=id%2CwebViewLink');
  });

  it('carries the injected access token as a bearer token', async () => {
    const { calls } = await upload();
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('sends a multipart boundary that actually appears in the body', async () => {
    const { contentType, body, boundary } = await upload();
    expect(contentType, 'no Content-Type on the upload').toMatch(/^multipart\//);
    expect(boundary, `no boundary in Content-Type: ${contentType}`).toBeTruthy();
    expect(body).toContain(boundary!);
  });

  it('sends exactly two parts: the metadata and the markdown content', async () => {
    const { body, boundary } = await upload();

    // A multipart body opens each part with `--boundary` and ends with `--boundary--`, so a
    // two-part body contains three delimiters in total.
    const delimiters = body.split(`--${boundary!}`).length - 1;
    expect(delimiters).toBe(3);
    expect(body.trimEnd().endsWith(`--${boundary!}--`)).toBe(true);
  });

  it('metadata part declares the Google Doc mimeType and the configured parent folder', async () => {
    const { body } = await upload();

    expect(body).toContain(`"mimeType":"${GOOGLE_DOC_MIME}"`);
    expect(body).toContain(`"parents":["${INPUT.folderId}"]`);
    expect(body).toContain(`"name":"${INPUT.title}"`);
    expect(body.toLowerCase()).toContain('content-type: application/json');
  });

  it('content part declares SOURCE_MIME and carries the markdown', async () => {
    const { body } = await upload();

    expect(SOURCE_MIME).toBe('text/markdown');
    // Part headers are case-normalised by the serializer, so compare case-insensitively.
    expect(body.toLowerCase()).toContain(`content-type: ${SOURCE_MIME}`);
    expect(body).toContain('The consumer redelivers in-flight jobs after a restart.');
  });

  it('sends the metadata part before the content part, as Drive requires', async () => {
    const { body } = await upload();
    expect(body.indexOf(GOOGLE_DOC_MIME)).toBeLessThan(body.indexOf(INPUT.markdown));
  });

  it('returns the id and webViewLink Drive reported', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(CREATED));
    const doc = await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN, fetchImpl });
    expect(doc).toEqual({ id: CREATED.id, url: CREATED.webViewLink });
  });

  /**
   * The distinction this guards is easy to get wrong and impossible to notice offline: Drive's
   * `uploadType=multipart` wants `multipart/related` (RFC 2387) with ordered, unnamed parts,
   * while a `FormData` body serializes to `multipart/form-data` with `Content-Disposition`
   * part headers. Drive rejects the latter, so reaching for FormData — which is the obvious
   * thing to reach for — makes every upload fail against the real API while every test that
   * only checks the parts still passes.
   */
  it('sends Content-Type: multipart/related, as Drive requires', async () => {
    const { contentType } = await upload();
    expect(contentType).toMatch(/^multipart\/related/);
  });
});

describe('createAnalysisDoc — never grants link-anyone sharing', () => {
  it('makes exactly one request and never calls permissions.create', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(CREATED));

    await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN, fetchImpl });

    // No second request at all, and nothing addressed at the permissions collection.
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes('/permissions'))).toBe(false);
    expect(calls.some((call) => call.url.includes('permissions'))).toBe(false);
  });
});

describe('createAnalysisDoc — failure paths', () => {
  async function failWith(status: number, statusText: string, body: string): Promise<Error> {
    const { fetchImpl } = recordingFetch(() => errorResponse(status, statusText, body));
    try {
      await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN, fetchImpl });
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected createAnalysisDoc to throw');
  }

  it('throws on any non-2xx response', async () => {
    const error = await failWith(500, 'Internal Server Error', 'backendError');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Drive files.create failed');
    expect(error.message).toContain('500');
  });

  it('a storageQuotaExceeded body points the operator at a Shared Drive', async () => {
    const error = await failWith(
      403,
      'Forbidden',
      JSON.stringify({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }),
    );
    expect(error.message).toContain('Shared Drive');
    expect(error.message).toContain('GOOGLE_DRIVE_FOLDER_ID');
  });

  it('403 and 404 produce distinct, actionable messages', async () => {
    const forbidden = await failWith(403, 'Forbidden', 'permission denied on folder');
    const notFound = await failWith(404, 'Not Found', 'File not found: folder');

    expect(forbidden.message).not.toBe(notFound.message);
    expect(forbidden.message).toContain('403');
    expect(notFound.message).toContain('404');
    expect(forbidden.message).toContain('permission denied on folder');
    expect(notFound.message).toContain('File not found: folder');
    // Both are actionable: they name the variable to check and the grant it needs.
    for (const message of [forbidden.message, notFound.message]) {
      expect(message).toContain('GOOGLE_DRIVE_FOLDER_ID');
      expect(message).toMatch(/Content manager|Writer/);
    }
  });

  it('throws when Drive returns 200 with no id or webViewLink', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ id: 'only-an-id' }));
    await expect(
      createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN, fetchImpl }),
    ).rejects.toThrow(/no id or webViewLink/);
  });

  it('no thrown message or stack contains the access token', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'Unauthorized', 'invalid authentication credentials'],
      [403, 'Forbidden', 'storageQuotaExceeded'],
      [404, 'Not Found', 'not found'],
      [429, 'Too Many Requests', 'rateLimitExceeded'],
      [500, 'Internal Server Error', 'backendError'],
    ];
    for (const [status, statusText, body] of cases) {
      const error = await failWith(status, statusText, body);
      expect(error.message).not.toContain(ACCESS_TOKEN);
      expect(error.message).not.toContain('ya29.');
      expect(error.message).not.toContain('Bearer');
      expect(error.stack ?? '').not.toContain(ACCESS_TOKEN);
    }
  });

  it('does not echo an enormous error body back unbounded', async () => {
    const error = await failWith(500, 'Internal Server Error', 'z'.repeat(5000));
    expect(error.message.length).toBeLessThan(1000);
  });

  it('rejects invalid input before making any request', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(CREATED));
    await expect(
      createAnalysisDoc(
        { title: '', markdown: 'x', folderId: 'f' },
        { accessToken: ACCESS_TOKEN, fetchImpl },
      ),
    ).rejects.toThrow();
    await expect(
      createAnalysisDoc(
        { title: 'ok', markdown: '', folderId: 'f' },
        { accessToken: ACCESS_TOKEN, fetchImpl },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
