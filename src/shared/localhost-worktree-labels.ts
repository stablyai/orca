const HOST_LABEL_MAX_LENGTH = 48
const TRAILING_MAIN_PATTERN = /(?:^|[-_\s/])main$/i

export const LOOPBACK_LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::'])

export function normalizeLocalhostHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

// Why: only http(s) loopback URLs with an explicit port can be attributed to a
// scanned workspace port and labeled; everything else stays as-is.
export function parseLoopbackUrlWithPort(rawUrl: string): URL | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  if (!url.port || !LOOPBACK_LOCALHOST_HOSTS.has(normalizeLocalhostHostname(url.hostname))) {
    return null
  }
  return url
}

// Why: 0.0.0.0 and :: are wildcard bind addresses, not connectable
// destinations (connecting to them fails on Windows). Normalize them to the
// matching loopback before using the host as a proxy target.
export function connectableLoopbackHost(hostname: string): string {
  const bare = normalizeLocalhostHostname(hostname)
  if (bare === '0.0.0.0') {
    return '127.0.0.1'
  }
  if (bare === '::') {
    return '::1'
  }
  return hostname
}

export type LocalhostWorktreeLabelInput = {
  projectName: string
  worktreeName: string
  worktreePath?: string | null
  repoId?: string | null
  worktreeId?: string | null
}

export type LocalhostWorktreeLabelRoute = {
  targetUrl: string
  projectName: string
  worktreeName: string
  worktreePath?: string | null
  repoId?: string | null
  worktreeId?: string | null
}

export type LocalhostWorktreeLabelResult = {
  url: string
  label: string
}

export function slugifyLocalhostWorktreeLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, HOST_LABEL_MAX_LENGTH)
    .replace(/-+$/g, '')
  return normalized || 'workspace'
}

export function getLocalhostWorktreeHostLabel(input: LocalhostWorktreeLabelInput): string {
  const projectSlug = slugifyLocalhostWorktreeLabel(input.projectName)
  const shortWorktreeName = getLocalhostWorktreeShortName(input.worktreePath ?? input.worktreeName)
  const worktreeSlug = slugifyLocalhostWorktreeLabel(shortWorktreeName)
  // Why: primary worktrees need project context so every project does not collapse into "main".
  if (worktreeSlug === 'main' || TRAILING_MAIN_PATTERN.test(input.worktreeName)) {
    return slugifyLocalhostWorktreeLabel(`${projectSlug}-main`)
  }
  return worktreeSlug
}

function getLocalhostWorktreeShortName(worktreeName: string): string {
  return (
    worktreeName
      .split(/[\\/]/)
      .map((part) => part.trim())
      .findLast(Boolean) ?? worktreeName
  )
}

export function getLocalhostWorktreeRouteKey(route: LocalhostWorktreeLabelRoute): string {
  if (route.worktreeId) {
    return `worktree:${route.worktreeId}:${route.targetUrl}`
  }
  if (route.repoId) {
    return `repo:${route.repoId}:${route.worktreeName}:${route.targetUrl}`
  }
  return `${route.projectName}:${route.worktreeName}:${route.targetUrl}`
}
