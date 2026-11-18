import { isAllowedPluginGitUrl } from './plugin-install-lockfile'

/** `ref` is empty when the input names no version: main resolves the newest version tag. */
export type PluginGitInstallInput = { url: string; ref: string }

export type PluginGitInstallInputError =
  | 'missing-git-url'
  | 'git-url-credentials'
  | 'invalid-git-url'
  | 'invalid-git-ref'

export type PluginGitInstallInputParseResult =
  | ({ ok: true } & PluginGitInstallInput)
  | { ok: false; reason: PluginGitInstallInputError }

const MAX_REF_LENGTH = 255
const SHORTHAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
const SCP_PATTERN = /^[^\s@/:]+@[A-Za-z0-9.-]+:[^\s]+$/

/** `git check-ref-format` rules plus no leading `-`, so a ref can never read as an option. */
export function isSafePluginGitRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= MAX_REF_LENGTH &&
    !ref.startsWith('-') &&
    !ref.startsWith('/') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.') &&
    !ref.endsWith('.lock') &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.includes('@{') &&
    ref !== '@' &&
    !/[~^:?*[\\]/.test(ref) &&
    ![...ref].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f) &&
    ref.split('/').every((part) => !part.startsWith('.'))
  )
}

/**
 * What users paste: `owner/repo`, a repository URL with or without `.git`, an SSH URL, or a
 * GitHub/GitLab release, tag, branch or commit page. `#ref` still pins a version explicitly.
 */
export function parsePluginGitInstallInput(input: string): PluginGitInstallInputParseResult {
  let value = input.trim()
  if (!value) {
    return { ok: false, reason: 'missing-git-url' }
  }
  let fragment = ''
  const hashIndex = value.indexOf('#')
  if (hashIndex !== -1) {
    fragment = value.slice(hashIndex + 1).trim()
    value = value.slice(0, hashIndex).trim()
  }
  if (!value) {
    return { ok: false, reason: 'missing-git-url' }
  }
  if (SHORTHAND_PATTERN.test(value)) {
    value = `https://github.com/${value}`
  } else if (
    !value.includes('://') &&
    !SCP_PATTERN.test(value) &&
    /^[^/\s]+\.[^/\s]+\//.test(value)
  ) {
    value = `https://${value}`
  }
  const parsed = SCP_PATTERN.test(value) ? { url: value, ref: '' } : parseUrlInput(value)
  if ('reason' in parsed) {
    return { ok: false, reason: parsed.reason }
  }
  // Why the page ref wins: a copied page link can carry an unrelated anchor such as #readme.
  const ref = parsed.ref || fragment
  if (!isAllowedPluginGitUrl(parsed.url)) {
    return { ok: false, reason: 'invalid-git-url' }
  }
  if (ref && !isSafePluginGitRef(ref)) {
    return { ok: false, reason: 'invalid-git-ref' }
  }
  return { ok: true, url: parsed.url, ref }
}

function parseUrlInput(
  value: string
): PluginGitInstallInput | { reason: Exclude<PluginGitInstallInputError, 'missing-git-url'> } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { reason: 'invalid-git-url' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    return { reason: 'invalid-git-url' }
  }
  // Why refuse rather than strip: a token pasted here would otherwise land in the lockfile.
  if (url.password || (url.protocol === 'https:' && url.username)) {
    return { reason: 'git-url-credentials' }
  }
  if (url.protocol === 'ssh:') {
    return { url: value, ref: '' }
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const page = pageRef(segments)
  if (page === null) {
    return { reason: 'invalid-git-url' }
  }
  const repository = segments.slice(0, page.repositoryLength).join('/')
  return { url: `https://${url.host}/${repository}`, ref: page.ref }
}

/** Repository path length and ref of a hosted page URL; null when no repository path remains. */
function pageRef(segments: string[]): { repositoryLength: number; ref: string } | null {
  const decode = (parts: string[]): string => {
    try {
      return parts.map(decodeURIComponent).join('/')
    } catch {
      // Why a control character: an undecodable ref must fail isSafePluginGitRef.
      return '\u0000'
    }
  }
  // GitLab: /group/sub/repo/-/tree/<ref>, /-/tags/<tag>, /-/releases/<tag>, /-/commit/<sha>.
  const gitLabMarker = segments.indexOf('-')
  if (gitLabMarker !== -1) {
    if (gitLabMarker < 2) {
      return null
    }
    const [kind, ...rest] = segments.slice(gitLabMarker + 1)
    const named = kind === 'tree' || kind === 'tags' || kind === 'releases' || kind === 'commit'
    return { repositoryLength: gitLabMarker, ref: named ? decode(rest) : '' }
  }
  // GitHub, Gitea, Codeberg: /owner/repo/tree/<ref>, /releases/tag/<tag>, /commit/<sha>.
  if (segments.length >= 3) {
    const [kind, ...rest] = segments.slice(2)
    if (kind === 'tree' || kind === 'commit') {
      return { repositoryLength: 2, ref: decode(rest) }
    }
    if (kind === 'releases') {
      return { repositoryLength: 2, ref: rest[0] === 'tag' ? decode(rest.slice(1)) : '' }
    }
    if (kind === 'tags' || kind === 'branches' || kind === 'commits') {
      return { repositoryLength: 2, ref: '' }
    }
  }
  return segments.length >= 2 ? { repositoryLength: segments.length, ref: '' } : null
}
