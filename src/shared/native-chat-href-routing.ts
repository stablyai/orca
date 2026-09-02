import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { fileUriToFilesystemPath } from './file-uri-path'

export type NativeChatHrefRoute =
  | { kind: 'web'; url: string }
  | { kind: 'file'; pathText: string; line: number | null }
  | { kind: 'none' }

const WEB_SCHEME_PATTERN = /^(?:https?|mailto):/i
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/

function parseLineFragment(hash: string): number | null {
  if (!hash) {
    return null
  }
  let decoded = hash
  try {
    decoded = decodeURIComponent(hash)
  } catch {
    // Keep the raw fragment when decoding fails.
  }
  const match = /^(?:L|line-?)([1-9]\d*)\b/i.exec(decoded)
  return match ? Number.parseInt(match[1]!, 10) : null
}

function stripQueryAndHash(value: string): { pathText: string; line: number | null } {
  const hashIndex = value.indexOf('#')
  const queryIndex = value.indexOf('?')
  const suffixIndex =
    hashIndex === -1 ? queryIndex : queryIndex === -1 ? hashIndex : Math.min(hashIndex, queryIndex)
  const pathText = suffixIndex === -1 ? value : value.slice(0, suffixIndex)
  const hash =
    hashIndex === -1
      ? ''
      : value.slice(hashIndex + 1, queryIndex > hashIndex ? queryIndex : undefined)
  return { pathText, line: parseLineFragment(hash) }
}

function maybeDecodeHrefPath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function routeNativeChatHref(href: string | null | undefined): NativeChatHrefRoute {
  const trimmed = href?.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return { kind: 'none' }
  }
  if (WEB_SCHEME_PATTERN.test(trimmed)) {
    return { kind: 'web', url: trimmed }
  }
  if (/^file:/i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return { kind: 'none' }
    }
    const pathText = fileUriToFilesystemPath(url)
    if (!pathText) {
      return { kind: 'none' }
    }
    return { kind: 'file', pathText, line: parseLineFragment(url.hash.slice(1)) }
  }
  if (!isWindowsAbsolutePathLike(trimmed) && SCHEME_PATTERN.test(trimmed)) {
    return { kind: 'none' }
  }
  const { pathText, line } = stripQueryAndHash(trimmed)
  const decodedPathText = maybeDecodeHrefPath(pathText)
  return decodedPathText ? { kind: 'file', pathText: decodedPathText, line } : { kind: 'none' }
}
