const PRODUCTION_HOSTS = new Set(['app.orca.dev', 'share.onorca.dev'])

export type WorktreeCreateDeepLink = {
  type: 'worktree-create'
  repo?: string
  name?: string
  branch?: string
}

export type WorktreeDeepLink = WorktreeCreateDeepLink

function sanitizeField(value: string | null, maxLength = 1024): string | undefined {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.slice(0, maxLength)
}

// `name`/`branch` reach git/worktree creation once a consumer wires this deep link through, and
// the link itself arrives from an unauthenticated `orca://` URL any local process or web page can
// open. Reject values a git ref/path resolver would misinterpret: a leading `-` (flag injection),
// a `..` path-traversal segment, or an embedded NUL. Slashes stay allowed since `feat/x`-style
// branch names are the common case.
function sanitizeGitRefField(value: string | null, maxLength = 256): string | undefined {
  const candidate = sanitizeField(value, maxLength)
  if (!candidate) {
    return undefined
  }
  if (candidate.startsWith('-')) {
    return undefined
  }
  if (candidate.includes('\0')) {
    return undefined
  }
  if (candidate.split(/[\\/]/).some((segment) => segment === '..')) {
    return undefined
  }
  return candidate
}

export function parseWorktreeDeepLink(value: string): WorktreeDeepLink | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  const isOrcaScheme = url.protocol === 'orca:'
  const isDevelopmentHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const isApprovedHttps =
    (url.protocol === 'https:' && PRODUCTION_HOSTS.has(url.hostname)) ||
    (url.protocol === 'http:' && isDevelopmentHost) ||
    (url.protocol === 'https:' && isDevelopmentHost)

  if (!isOrcaScheme && !isApprovedHttps) {
    return null
  }

  const rawPath = isOrcaScheme
    ? `${url.host}${url.pathname}`.replace(/^\/+/, '').replace(/\/+$/, '')
    : url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')

  const segments = rawPath.split('/')
  const domain = segments[0]
  const action = segments[1]

  if (domain === 'worktree' && (action === 'create' || action === 'new')) {
    const repo = sanitizeField(url.searchParams.get('repo'), 256)
    const name = sanitizeGitRefField(url.searchParams.get('name'), 256)
    const branch = sanitizeGitRefField(url.searchParams.get('branch'), 256)

    return {
      type: 'worktree-create',
      ...(repo ? { repo } : {}),
      ...(name ? { name } : {}),
      ...(branch ? { branch } : {})
    }
  }

  return null
}

export function worktreeDeepLinkFromArguments(argv: readonly string[]): WorktreeDeepLink | null {
  for (const value of argv) {
    // parseWorktreeDeepLink already validates scheme/host and path; a redundant startsWith/includes
    // check here rejected valid no-authority links like `orca:worktree/create?name=test`.
    const link = parseWorktreeDeepLink(value)
    if (link) {
      return link
    }
  }
  return null
}
