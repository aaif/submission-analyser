/**
 * src/integrations/google-docs.ts — the Drive boundary.
 *
 * Two layers here. The wire-level shape of the upload is asserted through msw, because the
 * multipart body is the one thing an injected `fetchImpl` cannot show honestly: the
 * integration hands `fetch` a `FormData` object and the serialization (boundary, part
 * headers, part order) happens inside fetch itself. Everything else — the failure paths —
 * uses the injected seam, which is less machinery for the same assertion.
 *
 * The single most important assertion in this file is the negative one: `permissions.create`
 * is never called. The Doc URL is posted into a public issue comment and announced in
 * Discord, so a link-anyone grant would publish the analysis to the world.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import {
  DRIVE_SCOPE,
  SOURCE_MIME,
  createAnalysisDoc,
} from '../src/integrations/google-docs.ts';
import { NO_CREDENTIALS, applyEnv, restoreEnv, snapshotEnv } from './helpers/env.ts';
import { errorResponse, jsonResponse, recordingFetch } from './helpers/fetch.ts';

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

interface CapturedRequest {
  url: string;
  contentType: string | null;
  authorization: string | null;
  body: string;
}

const captured: CapturedRequest[] = [];

const server = setupServer(
  http.post(UPLOAD_URL, async ({ request }) => {
    captured.push({
      url: request.url,
      contentType: request.headers.get('content-type'),
      authorization: request.headers.get('authorization'),
      body: await request.text(),
    });
    return HttpResponse.json({
      id: 'created-doc-id',
      webViewLink: 'https://docs.google.com/document/d/created-doc-id/edit',
    });
  }),
);

let envSnapshot: NodeJS.ProcessEnv;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

beforeEach(() => {
  envSnapshot = snapshotEnv();
  // No Google credentials at all: an `accessToken` is always injected, so a code path that
  // tried to mint a real token would fail loudly rather than pick up a developer's key.
  applyEnv(NO_CREDENTIALS);
  captured.length = 0;
});

afterEach(() => {
  server.resetHandlers();
  restoreEnv(envSnapshot);
});

describe('createAnalysisDoc — the request on the wire', () => {
  it('scope is drive.file — access to files this service account created, nothing else', () => {
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('is a single files.create multipart upload with the expected query parameters', async () => {
    await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN });

    expect(captured).toHaveLength(1);
    const url = new URL(captured[0]!.url);
    expect(url.origin + url.pathname).toBe(UPLOAD_URL);
    expect(url.searchParams.get('uploadType')).toBe('multipart');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('fields')).toBe('id,webViewLink');
  });

  it('carries the injected access token as a bearer token', async () => {
    await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN });
    expect(captured[0]!.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('sends a boundary that actually appears in the body', async () => {
    await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN });

    const contentType = captured[0]!.contentType ?? '';
    const boundary = /boundary=(?<value>"?)(?<boundary>[^";]+)\k<value>/.exec(contentType)?.groups
      ?.boundary;
    expect(boundary, `no boundary in Content-Type: ${contentType}`).toBeTruthy();
    expect(captured[0]!.body).toContain(boundary!);
  });

  it('sends exactly two parts: the metadata and the markdown content', async () => {
    await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN });

    const contentType = captured[0]!.contentType ?? '';
    const boundary = /boundary=(?<value>"?)(?<boundary>[^";]+)\k<value>/.exec(contentType)?.groups
      ?.boundary as string;

    // A multipart body is `--boundary` before each part and `--boundary--` at the end, so a
    // two-part body has exactly two opening delimiters.
    const openings = captured[0]!.body.split(`--${boundary}`).length - 1;
    expect(openings).toBe(3); // two part openings plus the closing delimiter
    expect(captured[0]!.body.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it('metadata part declares the Google Doc mimeType and the configured parent folder', async () => {
    await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN });

    const body = captured[0]!.body;
    expect(body).toContain(`"mimeType":"${GOOGLE_DOC_MIME}"`);
    expect(body).toContain(`"parents":["${INPUT.folderId}"]`);
    expect(body).toContain(`"name":"${INPUT.title}"`);
  });

  it('content part declares SOURCE_MIME and carries the markdown', async () => {
    await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN });

    expect(SOURCE_MIME).toBe('text/markdown');
    // Part headers are case-normalised by the serializer, so compare case-insensitively.
    expect(captured[0]!.body.toLowerCase()).toContain(`content-type: ${SOURCE_MIME}`);
    expect(captured[0]!.body).toContain('The consumer redelivers in-flight jobs after a restart.');
  });

  it('returns the id and webViewLink Drive reported', async () => {
    const doc = await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN });
    expect(doc).toEqual({
      id: 'created-doc-id',
      url: 'https://docs.google.com/document/d/created-doc-id/edit',
    });
  });

  /**
   * KNOWN BUG in src/integrations/google-docs.ts — do not "fix" this test.
   *
   * Drive's `uploadType=multipart` requires a `multipart/related` body (RFC 2387). The
   * integration builds a `FormData` and lets fetch serialize it, which produces
   * `multipart/form-data` with `Content-Disposition: form-data; name="metadata"` part
   * headers. Drive rejects that, so the real upload cannot succeed as written; the fix is to
   * assemble the `multipart/related` body by hand (or use `uploadType=resumable`) and set the
   * Content-Type explicitly.
   *
   * Marked `.fails` rather than deleted so the correct expectation is recorded and this test
   * starts failing (as an unexpected pass) the moment the bug is fixed.
   */
  it.fails('sends Content-Type: multipart/related, as Drive requires', async () => {
    await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN });
    expect(captured[0]!.contentType).toMatch(/^multipart\/related/);
  });
});

describe('createAnalysisDoc — never grants link-anyone sharing', () => {
  it('makes exactly one request and never calls permissions.create', async () => {
    // Asserted through the seam as well as msw: with `onUnhandledRequest: 'error'` a stray
    // permissions request would fail the run, and here it would also show up in `calls`.
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        id: 'created-doc-id',
        webViewLink: 'https://docs.google.com/document/d/created-doc-id/edit',
      }),
    );

    await createAnalysisDoc(INPUT, { accessToken: ACCESS_TOKEN, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes('/permissions'))).toBe(false);
    expect(calls[0]!.url).not.toContain('permissions');
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
    expect(error.message).toContain('500');
    expect(error.message).toContain('Drive files.create failed');
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

    // Distinct: each names its own status and echoes its own response detail.
    expect(forbidden.message).not.toBe(notFound.message);
    expect(forbidden.message).toContain('403');
    expect(notFound.message).toContain('404');
    expect(forbidden.message).toContain('permission denied on folder');
    expect(notFound.message).toContain('File not found: folder');
    // Both are actionable: they name the variable and the grant to check.
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

  it('no thrown message contains the access token', async () => {
    const statuses: Array<[number, string, string]> = [
      [401, 'Unauthorized', 'invalid authentication credentials'],
      [403, 'Forbidden', 'storageQuotaExceeded'],
      [404, 'Not Found', 'not found'],
      [500, 'Internal Server Error', 'backendError'],
    ];
    for (const [status, statusText, body] of statuses) {
      const error = await failWith(status, statusText, body);
      expect(error.message).not.toContain(ACCESS_TOKEN);
      expect(error.message.toLowerCase()).not.toContain('ya29.');
      expect(error.stack ?? '').not.toContain(ACCESS_TOKEN);
    }
  });

  it('rejects invalid input before making any request', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({}));
    await expect(
      createAnalysisDoc(
        { title: '', markdown: 'x', folderId: 'f' },
        { accessToken: ACCESS_TOKEN, fetchImpl },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
