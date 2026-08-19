import { randomBytes } from 'node:crypto';
import { JWT } from 'google-auth-library';
import * as v from 'valibot';
import { googleServiceAccount } from '../env.ts';
import {
  CreateDocInputSchema,
  CreatedDocSchema,
  type CreateDocInput,
  type CreatedDoc,
} from '../schema/integrations.ts';

/**
 * Creates a Google Doc from markdown.
 *
 * Implementation choice: a single Drive `files.create` multipart upload, with the target
 * mimeType set to a Google Doc and the uploaded bytes as `text/markdown`. Drive performs
 * the markdown -> Doc conversion server-side, so one request does the whole job.
 *
 * The Docs API `documents.batchUpdate` path was rejected deliberately. It inserts plain
 * text and then applies styling by character index, and every insert shifts the index of
 * everything after it — reproducing headings, tables and lists that way means maintaining
 * an index-remapping layer for no gain over a conversion Drive already does correctly.
 *
 * Scope is `drive.file` — access to files this service account created, nothing else. The
 * Doc is placed in a pre-shared folder and inherits its permissions; this module never
 * calls `permissions.create`, because the Doc URL is posted into a public issue comment
 * and a link-anyone grant would make the analysis world-readable.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

/** Kept as a constant: if Drive's markdown conversion ever regresses, `text/html` here is
 * the whole fallback. */
export const SOURCE_MIME = 'text/markdown';

export async function getAccessToken(): Promise<string> {
  const { clientEmail, privateKey } = googleServiceAccount();
  const jwt = new JWT({ email: clientEmail, key: privateKey, scopes: [DRIVE_SCOPE] });
  const { access_token: token } = await jwt.authorize();
  if (!token) throw new Error('Google service-account authorization returned no access token.');
  return token;
}

export async function createAnalysisDoc(
  input: CreateDocInput,
  deps: { accessToken?: string; fetchImpl?: typeof fetch } = {},
): Promise<CreatedDoc> {
  const { title, markdown, folderId } = v.parse(CreateDocInputSchema, input);
  const token = deps.accessToken ?? (await getAccessToken());
  const doFetch = deps.fetchImpl ?? fetch;

  const metadata = { name: title, mimeType: GOOGLE_DOC_MIME, parents: [folderId] };

  // Assembled by hand rather than with FormData. `uploadType=multipart` is RFC 2387
  // `multipart/related` with ordered, unnamed parts; FormData serializes to
  // `multipart/form-data` with `Content-Disposition: form-data; name=...` headers, which
  // Drive rejects. The two look interchangeable and are not.
  const boundary = `flue-${randomBytes(16).toString('hex')}`;
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${SOURCE_MIME}; charset=UTF-8\r\n\r\n` +
    `${markdown}\r\n` +
    `--${boundary}--\r\n`;

  const url = new URL(DRIVE_UPLOAD_URL);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('fields', 'id,webViewLink');

  const response = await doFetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const detail = await safeText(response);
    throw new Error(
      `Drive files.create failed with ${response.status} ${response.statusText}. ${hint(
        response.status,
        detail,
      )}`,
    );
  }

  const payload = (await response.json()) as { id?: string; webViewLink?: string };
  if (!payload.id || !payload.webViewLink) {
    throw new Error('Drive files.create returned no id or webViewLink.');
  }
  return v.parse(CreatedDocSchema, { id: payload.id, url: payload.webViewLink });
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/** Turns the two Drive failures that actually happen into actionable messages. */
export function hint(status: number, detail: string): string {
  if (detail.includes('storageQuotaExceeded')) {
    return (
      'A service account has no Drive storage quota of its own, so GOOGLE_DRIVE_FOLDER_ID ' +
      'must name a folder on a Shared Drive. See docs/secrets.md.'
    );
  }
  if (status === 404 || status === 403) {
    return (
      'Check that GOOGLE_DRIVE_FOLDER_ID exists and is shared with the service account as ' +
      `Content manager or Writer. Response: ${detail}`
    );
  }
  return detail;
}
