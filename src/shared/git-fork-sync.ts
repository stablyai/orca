export type ForkSyncMode = 'ask' | 'safe-auto' | 'off'

export type GitForkSyncBlockedReason =
  | 'missing-origin'
  | 'missing-upstream'
  | 'upstream-mismatch'
  | 'missing-upstream-default-branch'
  | 'missing-origin-branch'
  | 'diverged'

export type GitForkSyncResult = {
  status: 'up-to-date' | 'synced' | 'blocked'
  reason?: GitForkSyncBlockedReason
  originRemote: string
  upstreamRemote: string
  branchName?: string
  ahead: number
  behind: number
}

export type GitForkSyncExpectedUpstream = {
  owner: string
  repo: string
}

export type GitForkSyncRunner = (args: string[]) => Promise<{ stdout: string; stderr?: string }>

const DEFAULT_ORIGIN_REMOTE = 'origin'
const DEFAULT_UPSTREAM_REMOTE = 'upstream'
const DEFAULT_BRANCH_FALLBACKS = ['main', 'master']
const GITHUB_HOSTS = new Set(['github.com', 'ssh.github.com'])

function parseRemoteHeadBranch(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^ref:\s+refs\/heads\/(.+?)\s+HEAD$/.exec(line.trim())
    if (match?.[1]) {
      return match[1]
    }
  }
  return null
}

function parseAheadBehind(stdout: string): { ahead: number; behind: number } {
  const [aheadRaw, behindRaw] = stdout.trim().split(/\s+/, 2)
  return {
    ahead: Number.parseInt(aheadRaw ?? '0', 10) || 0,
    behind: Number.parseInt(behindRaw ?? '0', 10) || 0
  }
}

async function remoteExists(runGit: GitForkSyncRunner, remote: string): Promise<boolean> {
  const { stdout } = await runGit(['remote'])
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(remote)
}

function cleanGitHubRemotePath(path: string): string | null {
  const normalized = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length !== 2) {
    return null
  }
  return parts.join('/').toLowerCase()
}

function parseGitHubRemotePath(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/^git\+/, '')
  const shorthand = trimmed.match(/^github:([^/].+)$/i)
  if (shorthand) {
    return cleanGitHubRemotePath(shorthand[1])
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+)$/)
    if (scpLike && GITHUB_HOSTS.has(scpLike[1].toLowerCase())) {
      return cleanGitHubRemotePath(scpLike[2])
    }
  }

  try {
    const url = new URL(trimmed)
    if (
      !['git:', 'http:', 'https:', 'ssh:'].includes(url.protocol.toLowerCase()) ||
      !GITHUB_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return null
    }
    return cleanGitHubRemotePath(url.pathname)
  } catch {
    return null
  }
}

export function validateGitForkSyncExpectedUpstream(
  value: unknown,
  options: { required: true }
): GitForkSyncExpectedUpstream
export function validateGitForkSyncExpectedUpstream(
  value: unknown,
  options?: { required?: false }
): GitForkSyncExpectedUpstream | null
export function validateGitForkSyncExpectedUpstream(
  value: unknown,
  options: { required?: boolean } = {}
): GitForkSyncExpectedUpstream | null {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new Error('Expected upstream is required.')
    }
    return null
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid expected upstream.')
  }
  const candidate = value as { owner?: unknown; repo?: unknown }
  const owner = typeof candidate.owner === 'string' ? candidate.owner.trim() : ''
  const repo = typeof candidate.repo === 'string' ? candidate.repo.trim() : ''
  if (!owner || !repo) {
    throw new Error('Invalid expected upstream.')
  }
  return { owner, repo }
}

async function remoteMatchesExpectedUpstream(
  runGit: GitForkSyncRunner,
  remote: string,
  expected: GitForkSyncExpectedUpstream
): Promise<boolean> {
  const owner = expected.owner.trim().toLowerCase()
  const repo = expected.repo.trim().toLowerCase()
  if (!owner || !repo) {
    return false
  }
  try {
    const { stdout } = await runGit(['remote', 'get-url', remote])
    return parseGitHubRemotePath(stdout) === `${owner}/${repo}`
  } catch {
    return false
  }
}

async function fetchRemoteBranch(
  runGit: GitForkSyncRunner,
  remote: string,
  branchName: string
): Promise<boolean> {
  try {
    await runGit([
      'fetch',
      '--no-tags',
      '--prune',
      remote,
      `+refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`
    ])
    return true
  } catch {
    return false
  }
}

async function resolveCommit(runGit: GitForkSyncRunner, ref: string): Promise<string | null> {
  try {
    return (await runGit(['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim() || null
  } catch {
    return null
  }
}

async function resolveRemoteDefaultBranch(
  runGit: GitForkSyncRunner,
  remote: string
): Promise<string | null> {
  try {
    const { stdout } = await runGit(['ls-remote', '--symref', remote, 'HEAD'])
    const branchName = parseRemoteHeadBranch(stdout)
    if (branchName) {
      return branchName
    }
  } catch {
    // Fall through to common branch names so offline/stale remote metadata can
    // still support the conservative fast-forward check when refs exist.
  }

  for (const branchName of DEFAULT_BRANCH_FALLBACKS) {
    try {
      await runGit(['rev-parse', '--verify', `refs/remotes/${remote}/${branchName}^{commit}`])
      return branchName
    } catch {
      // Try the next common default branch.
    }
  }
  return null
}

async function isAncestor(
  runGit: GitForkSyncRunner,
  ancestorOid: string,
  descendantOid: string
): Promise<boolean> {
  try {
    await runGit(['merge-base', '--is-ancestor', ancestorOid, descendantOid])
    return true
  } catch {
    return false
  }
}

export async function syncForkDefaultBranch(
  runGit: GitForkSyncRunner,
  options: {
    originRemote?: string
    upstreamRemote?: string
    expectedUpstream?: GitForkSyncExpectedUpstream | null
  } = {}
): Promise<GitForkSyncResult> {
  const originRemote = options.originRemote ?? DEFAULT_ORIGIN_REMOTE
  const upstreamRemote = options.upstreamRemote ?? DEFAULT_UPSTREAM_REMOTE
  const expectedUpstream = validateGitForkSyncExpectedUpstream(options.expectedUpstream)
  const baseResult = { originRemote, upstreamRemote, ahead: 0, behind: 0 }

  if (!(await remoteExists(runGit, originRemote))) {
    return { ...baseResult, status: 'blocked', reason: 'missing-origin' }
  }
  if (!(await remoteExists(runGit, upstreamRemote))) {
    return { ...baseResult, status: 'blocked', reason: 'missing-upstream' }
  }
  if (
    expectedUpstream &&
    !(await remoteMatchesExpectedUpstream(runGit, upstreamRemote, expectedUpstream))
  ) {
    return { ...baseResult, status: 'blocked', reason: 'upstream-mismatch' }
  }

  const branchName = await resolveRemoteDefaultBranch(runGit, upstreamRemote)
  if (!branchName) {
    return { ...baseResult, status: 'blocked', reason: 'missing-upstream-default-branch' }
  }
  await runGit(['check-ref-format', `refs/heads/${branchName}`])

  const originRef = `refs/remotes/${originRemote}/${branchName}`
  const upstreamRef = `refs/remotes/${upstreamRemote}/${branchName}`
  const resultWithBranch = { ...baseResult, branchName }

  if (!(await fetchRemoteBranch(runGit, upstreamRemote, branchName))) {
    return { ...resultWithBranch, status: 'blocked', reason: 'missing-upstream-default-branch' }
  }
  if (!(await fetchRemoteBranch(runGit, originRemote, branchName))) {
    return { ...resultWithBranch, status: 'blocked', reason: 'missing-origin-branch' }
  }

  const upstreamOid = await resolveCommit(runGit, upstreamRef)
  if (!upstreamOid) {
    return { ...resultWithBranch, status: 'blocked', reason: 'missing-upstream-default-branch' }
  }
  const originOid = await resolveCommit(runGit, originRef)
  if (!originOid) {
    return { ...resultWithBranch, status: 'blocked', reason: 'missing-origin-branch' }
  }

  const counts = parseAheadBehind(
    (await runGit(['rev-list', '--left-right', '--count', `${originOid}...${upstreamOid}`])).stdout
  )

  if (counts.ahead > 0 || !(await isAncestor(runGit, originOid, upstreamOid))) {
    return { ...resultWithBranch, ...counts, status: 'blocked', reason: 'diverged' }
  }
  if (counts.behind === 0) {
    return { ...resultWithBranch, ...counts, status: 'up-to-date' }
  }

  await runGit(['push', originRemote, `${upstreamOid}:refs/heads/${branchName}`])
  await fetchRemoteBranch(runGit, originRemote, branchName)
  return { ...resultWithBranch, ...counts, status: 'synced' }
}
