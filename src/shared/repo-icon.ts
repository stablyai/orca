export type RepoIconImageSource = 'upload' | 'favicon' | 'github'

export type RepoIcon =
  | { type: 'lucide'; name: string }
  | { type: 'emoji'; emoji: string }
  | { type: 'image'; src: string; source: RepoIconImageSource; label?: string }

export const MAX_REPO_ICON_UPLOAD_BYTES = 256 * 1024
export const MAX_REPO_ICON_DATA_URL_LENGTH = 400 * 1024

const LUCIDE_ICON_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const isRepoIconImageSource = (value: string): value is RepoIconImageSource =>
  value === 'upload' || value === 'favicon' || value === 'github'

function isSupportedImageSrc(src: string, source: RepoIconImageSource): boolean {
  if (source === 'upload') {
    return /^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/i.test(src)
  }

  let url: URL
  try {
    url = new URL(src)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') {
    return false
  }

  if (source === 'github') {
    return url.hostname === 'github.com' && /^\/[^/?#]+\.png$/i.test(url.pathname)
  }

  return url.hostname === 'www.google.com' && url.pathname === '/s2/favicons'
}

export function sanitizeRepoIcon(value: unknown): RepoIcon | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const candidate = value as Record<string, unknown>
  if (candidate.type === 'lucide') {
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
    if (!LUCIDE_ICON_NAME_PATTERN.test(name) || name.length > 40) {
      return undefined
    }
    return { type: 'lucide', name }
  }

  if (candidate.type === 'emoji') {
    const emoji = typeof candidate.emoji === 'string' ? candidate.emoji.trim() : ''
    if (!emoji || emoji.length > 16) {
      return undefined
    }
    return { type: 'emoji', emoji }
  }

  if (candidate.type === 'image') {
    const src = typeof candidate.src === 'string' ? candidate.src.trim() : ''
    const source = typeof candidate.source === 'string' ? candidate.source : ''
    if (!isRepoIconImageSource(source) || src.length > MAX_REPO_ICON_DATA_URL_LENGTH) {
      return undefined
    }
    if (!isSupportedImageSrc(src, source)) {
      return undefined
    }
    const label = typeof candidate.label === 'string' ? candidate.label.trim().slice(0, 80) : ''
    return {
      type: 'image',
      src,
      source: source as RepoIconImageSource,
      ...(label ? { label } : {})
    }
  }

  return undefined
}
