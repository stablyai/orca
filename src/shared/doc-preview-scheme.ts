/**
 * Wire shape for the local document-preview scheme. The main process answers
 * `orca-preview://<grantId>/<relative-path>` by reading the owning workspace's
 * disk over the same channels the editor uses, so remote HTML docs render in a
 * local webview instead of being routed through the remote-browsing machinery.
 */
export const DOC_PREVIEW_SCHEME = 'orca-preview'

/** Why: non-persistent and its own partition — preview bytes never share storage with user browsing or workspace browser profiles. */
export const DOC_PREVIEW_PARTITION = 'orca-doc-preview'

export const DOC_PREVIEW_MINT_GRANT_CHANNEL = 'docPreview:mintGrant'
export const DOC_PREVIEW_REVOKE_GRANT_CHANNEL = 'docPreview:revokeGrant'
export const DOC_PREVIEW_AUTHORIZE_DIRECTORY_CHANNEL = 'docPreview:authorizeDirectory'
export const DOC_PREVIEW_EXTERNAL_LINK_CHANNEL = 'docPreview:externalLink'
/**
 * The preview guest's preload reports a trusted anchor click here. Renderer↔main only — no paired
 * client ever sees it, and main gates every report on the sender being a live, grant-bound preview guest.
 */
export const DOC_PREVIEW_LINK_CLICK_CHANNEL = 'docPreview:linkClick'
/** The one out-of-band route from the preview's main-side fences to the shell hosting it. */
export const DOC_PREVIEW_LOAD_FAILURE_CHANNEL = 'docPreview:loadFailure'

/** Why: an unreadable document still answers with a real HTTP status, so the guest paints the
 *  handler's plain-text body instead of failing to load. The shell needs the reason out-of-band. */
export type DocPreviewFileFailureReason =
  | 'authorization-required'
  | 'too-large'
  | 'unsupported-asset'
  | 'unreadable'

export type DocPreviewFileFailure = {
  grantId: string
  relativePath: string
  reason: DocPreviewFileFailureReason
}

/**
 * A download the preview partition refused. Why it carries no path: the document names the file it
 * offers, and the notice this becomes is Orca's chrome — a payload with a path invites rendering
 * page-authored text in the app's own UI, and a path equal to the entry document's would route a
 * refused download into the panel that hides the page.
 */
export type DocPreviewDownloadBlocked = {
  grantId: string
  reason: 'download-blocked'
}

export type DocPreviewFailure = DocPreviewFileFailure | DocPreviewDownloadBlocked

export const DOC_PREVIEW_GRANT_ID_PATTERN = /^[0-9a-f]{32}$/

export function isDocPreviewGrantId(value: string): boolean {
  return DOC_PREVIEW_GRANT_ID_PATTERN.test(value)
}

/** Encodes each segment separately so `/` keeps its separator meaning and `#`/`?` cannot split the path. */
export function buildDocPreviewUrl(grantId: string, relativePath: string): string {
  const segments = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
  return `${DOC_PREVIEW_SCHEME}://${grantId}/${segments.join('/')}`
}

export type DocPreviewUrlTarget = {
  grantId: string
  /** Slash-joined, percent-decoded path segments; never leading-slashed. */
  relativePath: string
}

/**
 * Whether a string is, or is trying to look like, a preview URL. Deliberately a prefix test rather
 * than a parse: this answers for text a document chose — a title Chromium fell back to, most of
 * all — where anything carrying a grant must be refused even when it would not parse.
 */
export function isDocPreviewUrl(candidate: string): boolean {
  return candidate.trimStart().toLowerCase().startsWith(`${DOC_PREVIEW_SCHEME}://`)
}

export function parseDocPreviewUrl(rawUrl: string): DocPreviewUrlTarget | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${DOC_PREVIEW_SCHEME}:`) {
    return null
  }
  const grantId = parsed.hostname
  if (!isDocPreviewGrantId(grantId)) {
    return null
  }
  const segments: string[] = []
  for (const rawSegment of parsed.pathname.split('/')) {
    if (rawSegment.length === 0) {
      continue
    }
    let segment: string
    try {
      segment = decodeURIComponent(rawSegment)
    } catch {
      return null
    }
    segments.push(segment)
  }
  return { grantId, relativePath: segments.join('/') }
}
