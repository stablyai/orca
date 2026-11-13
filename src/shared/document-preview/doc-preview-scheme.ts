/** Read workspace-owned local/remote disk over editor channels for orca-preview://grant/path; render remote HTML in local webviews without remote-browsing routing. */
export const DOC_PREVIEW_SCHEME = 'orca-preview'

/** Why: non-persistent and its own partition — preview bytes never share storage with user browsing or workspace browser profiles. */
export const DOC_PREVIEW_PARTITION = 'orca-doc-preview'

export const DOC_PREVIEW_MINT_GRANT_CHANNEL = 'docPreview:mintGrant'
export const DOC_PREVIEW_REVOKE_GRANT_CHANNEL = 'docPreview:revokeGrant'
export const DOC_PREVIEW_AUTHORIZE_DIRECTORY_CHANNEL = 'docPreview:authorizeDirectory'
export const DOC_PREVIEW_EXTERNAL_LINK_CHANNEL = 'docPreview:externalLink'
/** Renderer/main only: accept trusted anchor reports exclusively from live grant-bound preview guests; never expose this channel to paired clients. */
export const DOC_PREVIEW_LINK_CLICK_CHANNEL = 'docPreview:linkClick'

export type DocPreviewLinkModifiers = {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

export type DocPreviewExternalLink = {
  url: string
  grantId?: string
  modifiers?: DocPreviewLinkModifiers
}
/** The one out-of-band route from the preview's main-side fences to the shell hosting it. */
export const DOC_PREVIEW_LOAD_FAILURE_CHANNEL = 'docPreview:loadFailure'

/** Unreadable files still return HTTP bodies that the guest paints; deliver failure reasons out-of-band to the shell. */
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

/** Omit page-authored download paths from app chrome; a forged entry-document path could otherwise hide the page behind its error panel. */
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

/** Prefix-test even malformed document-authored URLs/titles so grant-bearing text cannot escape simply by failing URL parsing. */
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
