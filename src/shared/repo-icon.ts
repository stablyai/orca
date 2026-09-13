import { validateRasterImageDataUri } from './image-data-uri'

export type RepoIconImageSource = 'upload' | 'file' | 'favicon' | 'github'

export type RepoIcon =
  | { type: 'lucide'; name: string }
  | { type: 'emoji'; emoji: string }
  | { type: 'image'; src: string; source: RepoIconImageSource; label?: string }

export const MAX_REPO_ICON_UPLOAD_BYTES = 256 * 1024
export const MAX_REPO_ICON_DATA_URL_LENGTH = 400 * 1024

const LUCIDE_ICON_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const isRepoIconImageSource = (value: string): value is RepoIconImageSource =>
  value === 'upload' || value === 'file' || value === 'favicon' || value === 'github'

export function faviconUrlFromWebsite(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    return null
  }

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return null
    }
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=64`
  } catch {
    return null
  }
}

type GitHubAvatarSlug = { owner: string; repo: string; host?: string }

/**
 * Pick the owner whose avatar represents a repo, given its `origin` and fork parent.
 * Why: a same-name fork is a personal copy, so it reads as the parent project; a
 * renamed fork is its own project and keeps its own owner.
 */
export function githubAvatarSlug(
  origin: GitHubAvatarSlug | null | undefined,
  upstream: GitHubAvatarSlug | null | undefined
): GitHubAvatarSlug | null {
  const renamedFork =
    origin && upstream && origin.repo.toLowerCase() !== upstream.repo.toLowerCase()
  return renamedFork ? origin : (upstream ?? origin ?? null)
}

// Why: shared default icon URL/label for main auto-detect and the renderer picker.
export function githubAvatarIcon(slug: GitHubAvatarSlug): RepoIcon {
  // Why: GHES uses the same /<login>.png avatar path as github.com.
  const host = normalizeGitHubAvatarHost(slug.host)
  return {
    type: 'image',
    src: `https://${host}/${encodeURIComponent(slug.owner)}.png?size=64`,
    source: 'github',
    label: `${slug.owner}/${slug.repo}`
  }
}

function normalizeGitHubAvatarHost(rawHost?: string): string {
  const candidate = rawHost?.trim().toLowerCase() || 'github.com'
  try {
    const url = new URL(`https://${candidate}`)
    // Why: only bare hostnames — reject credentials, paths, query, or hash.
    // Explicit default port 443 is stripped by URL serialization, so accept the
    // canonical `hostname:443` form too or valid GHES avatars on 443 fall back.
    return !url.username &&
      !url.password &&
      (url.host === candidate || `${url.host}:443` === candidate) &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
      ? url.host
      : 'github.com'
  } catch {
    return 'github.com'
  }
}

function computeIsSupportedImageSrc(src: string, source: RepoIconImageSource): boolean {
  if (source === 'upload') {
    return (
      /^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/i.test(src) &&
      validateRasterImageDataUri(src) !== null
    )
  }

  if (source === 'file') {
    return (
      /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(src) &&
      validateRasterImageDataUri(src) !== null
    )
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
    // Why: only owner-avatar paths; no credentials (GHES hosts may be internal).
    return !url.username && !url.password && /^\/[^/?#]+\.png$/i.test(url.pathname)
  }

  return url.hostname === 'www.google.com' && url.pathname === '/s2/favicons'
}

type ImageSrcVerdict = { src: unknown; source: unknown; supported: boolean }

/**
 * Why: `getRepos()` re-hydrates every repo on every call, and validating one inline data URI means
 * scanning a 400 KB string twice with a regex and base64-decoding its header. `hydrateRepo` is
 * handed the *same* persisted `repoIcon` object every time, so the verdict is cached on that object
 * and dies with it — no cap, no eviction, and nothing retained once a repo or an icon is replaced.
 *
 * `src`/`source` are re-checked on a hit, so mutating the persisted icon in place cannot serve a
 * stale verdict. Both are the identical string references in the steady state, so the compare is a
 * pointer check, not a 400 KB scan.
 */
const imageSrcVerdicts = new WeakMap<object, ImageSrcVerdict>()

function isSupportedImageSrc(
  candidate: Record<string, unknown>,
  src: string,
  source: RepoIconImageSource
): boolean {
  const cached = imageSrcVerdicts.get(candidate)
  if (cached && cached.src === candidate.src && cached.source === candidate.source) {
    return cached.supported
  }
  const supported = computeIsSupportedImageSrc(src, source)
  imageSrcVerdicts.set(candidate, { src: candidate.src, source: candidate.source, supported })
  return supported
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
    if (!isSupportedImageSrc(candidate, src, source)) {
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
