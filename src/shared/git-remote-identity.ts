export type GitRemoteIdentity = {
  canonicalKey: string
  remoteName: string
  remoteUrl: string
}

type GitRemoteEntry = {
  name: string
  url: string
}

function stripGitSuffix(path: string): string {
  return path.endsWith('.git') ? path.slice(0, -4) : path
}

function normalizeRemotePath(path: string): string {
  return stripGitSuffix(path.replace(/^\/+/, '').replace(/\/+$/, ''))
}

function normalizeRemoteHost(host: string): string {
  return host.trim().toLowerCase()
}

function isLocalFilesystemRemote(remoteUrl: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(remoteUrl)
}

export function normalizeGitRemoteUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim()
  if (!trimmed) {
    return null
  }
  if (isLocalFilesystemRemote(trimmed)) {
    return null
  }

  const scpMatch = trimmed.includes('://') ? null : /^([^@\s:]+@)?([^:\s]+):(.+)$/.exec(trimmed)
  if (scpMatch) {
    const host = normalizeRemoteHost(scpMatch[2] ?? '')
    const path = normalizeRemotePath(scpMatch[3] ?? '')
    return host && path ? `${host}/${path}` : null
  }

  try {
    const parsed = new URL(trimmed)
    const host = normalizeRemoteHost(parsed.hostname)
    const path = normalizeRemotePath(parsed.pathname)
    return host && path ? `${host}/${path}` : null
  } catch {
    return null
  }
}

export function parseGitRemoteVerboseOutput(stdout: string): GitRemoteEntry[] {
  const entries: GitRemoteEntry[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.endsWith('(fetch)')) {
      continue
    }
    const match = /^(\S+)\s+(.+?)\s+\(fetch\)$/.exec(line)
    if (!match) {
      continue
    }
    const name = match[1]?.trim()
    const url = match[2]?.trim()
    if (name && url) {
      entries.push({ name, url })
    }
  }
  return entries
}

function primaryRemoteSortKey(entry: GitRemoteEntry): number {
  if (entry.name === 'upstream') {
    return 0
  }
  if (entry.name === 'origin') {
    return 1
  }
  return 2
}

/** Every remote with a usable canonical key, in primary-remote precedence order — so
 *  `[0]` is the probe's primary `identity`. Only byte-identical URLs
 *  collapse: the canonical key alone is too coarse, because a GHES endpoint port lives
 *  in the URL and not in the key, so two spellings of one repo can still belong to two
 *  different projects. */
export function deriveGitRemoteIdentities(stdout: string): GitRemoteIdentity[] {
  const entries = parseGitRemoteVerboseOutput(stdout)
    .map((entry) => ({
      ...entry,
      canonicalKey: normalizeGitRemoteUrl(entry.url)
    }))
    .filter((entry): entry is GitRemoteEntry & { canonicalKey: string } => !!entry.canonicalKey)
    .sort((left, right) => {
      const priority = primaryRemoteSortKey(left) - primaryRemoteSortKey(right)
      return priority === 0 ? left.name.localeCompare(right.name) : priority
    })
  const bySpelling = new Map<string, GitRemoteIdentity>()
  for (const entry of entries) {
    // `\0`, never a raw NUL byte: a raw NUL makes git treat this source file as binary.
    const spelling = `${entry.canonicalKey}\0${entry.url}`
    if (!bySpelling.has(spelling)) {
      bySpelling.set(spelling, {
        canonicalKey: entry.canonicalKey,
        remoteName: entry.name,
        remoteUrl: entry.url
      })
    }
  }
  return [...bySpelling.values()]
}
