import { foldComparableGitHubHost, foldWwwHostAlias } from './git-remote-host-alias'

const DEFAULT_REMOTE_PORTS: Record<string, string> = {
  'git:': '9418',
  'git+ssh:': '22',
  'ssh:': '22',
  'http:': '80',
  'https:': '443'
}

// Why: an explicit non-default port names a different endpoint, so it must stay in the identity.
function foldGitHubEndpoint(protocol: string, hostname: string, port: string): string {
  const host = foldComparableGitHubHost(hostname)
  if (!port || port === DEFAULT_REMOTE_PORTS[protocol]) {
    return host
  }
  // GitHub documents ssh.github.com:443 as SSH-over-HTTPS for its default SSH endpoint.
  if (port === '443' && foldWwwHostAlias(hostname) === 'ssh.github.com') {
    return host
  }
  return `${host}:${port}`
}

function parseGitHubRemoteUrl(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim()
  const scpMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+)$/i)
  if (scpMatch) {
    if (foldComparableGitHubHost(scpMatch[1]!) !== 'github.com') {
      return null
    }
    return { owner: scpMatch[2]!, repo: scpMatch[3]!.replace(/\.git$/i, '') }
  }
  try {
    const parsed = new URL(trimmed)
    const protocol = parsed.protocol.toLowerCase()
    if (!['git:', 'git+ssh:', 'http:', 'https:', 'ssh:'].includes(protocol)) {
      return null
    }
    if (foldGitHubEndpoint(protocol, parsed.hostname, parsed.port) !== 'github.com') {
      return null
    }
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return null
    }
    return { owner: parts[0], repo: parts[1].replace(/\.git$/i, '') }
  } catch {
    return null
  }
}

// Why: comparison is GitHub-only; raw string equality would let an unsupported-provider
// remote match persisted metadata and be removed by cleanup.
export function sameGitHubRemoteUrl(left: string, right: string): boolean {
  const parsedLeft = parseGitHubRemoteUrl(left)
  const parsedRight = parseGitHubRemoteUrl(right)
  return Boolean(
    parsedLeft &&
    parsedRight &&
    parsedLeft.owner.toLowerCase() === parsedRight.owner.toLowerCase() &&
    parsedLeft.repo.toLowerCase() === parsedRight.repo.toLowerCase()
  )
}
