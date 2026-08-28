export type LinearInlineMediaSource = 'description' | 'comment' | 'child-description'

export type LinearInlineMedia = {
  source: LinearInlineMediaSource
  sourceId?: string
  url: string
  altText?: string | null
  fileName?: string | null
  linearUpload: boolean
}

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g
const HTML_MEDIA_SRC_PATTERN = /<(?:img|video|audio|source)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
const LINEAR_UPLOAD_HOST = 'uploads.linear.app'

export function extractLinearInlineMedia(
  markdown: string | null | undefined,
  source: LinearInlineMediaSource,
  sourceId?: string
): LinearInlineMedia[] {
  if (!markdown) {
    return []
  }
  const media: LinearInlineMedia[] = []
  const seen = new Set<string>()

  for (const match of markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    addMedia(media, seen, normalizeMarkdownUrl(match[2] ?? ''), source, sourceId, match[1] ?? null)
  }
  for (const match of markdown.matchAll(HTML_MEDIA_SRC_PATTERN)) {
    addMedia(media, seen, match[1] ?? '', source, sourceId, null)
  }

  return media
}

function addMedia(
  media: LinearInlineMedia[],
  seen: Set<string>,
  rawUrl: string,
  source: LinearInlineMediaSource,
  sourceId: string | undefined,
  altText: string | null
): void {
  const url = rawUrl.trim()
  if (!isMediaUrl(url) || seen.has(url)) {
    return
  }
  seen.add(url)
  media.push({
    source,
    ...(sourceId ? { sourceId } : {}),
    url,
    altText: altText || null,
    fileName: fileNameFromUrl(url),
    linearUpload: isLinearUploadUrl(url)
  })
}

function normalizeMarkdownUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isMediaUrl(url: string): boolean {
  if (!url) {
    return false
  }
  if (url.startsWith('data:image/') || url.startsWith('data:video/')) {
    return true
  }
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function isLinearUploadUrl(url: string): boolean {
  try {
    return new URL(url).hostname === LINEAR_UPLOAD_HOST
  } catch {
    return false
  }
}

function fileNameFromUrl(url: string): string | null {
  if (url.startsWith('data:')) {
    return null
  }
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').findLast(Boolean)
    return last ? decodeURIComponent(last) : null
  } catch {
    return null
  }
}
