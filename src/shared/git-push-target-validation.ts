import type { GitPushTarget } from './worktree/types'

const SAFE_REMOTE_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid PR push target ${name}.`)
  }
}

export function isSafeGitRemoteName(remoteName: string): boolean {
  if (remoteName.length === 0 || remoteName.length > 100) {
    return false
  }
  return remoteName.split('/').every((segment) => {
    // Git accepts slash-separated remote names; each segment still needs to be
    // a concrete name so persisted push targets cannot smuggle path traversal.
    return (
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      SAFE_REMOTE_NAME_SEGMENT.test(segment)
    )
  })
}

// Why: the relay allows a fork remote to be added via git.exec, so the exec
// validator needs the same URL rule the pushTarget-carrying RPCs already apply.
export function isSafePushTargetRemoteUrl(remoteUrl: string): boolean {
  const scp = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(remoteUrl)
  let path: string
  if (scp) {
    path = scp[2]!
  } else {
    try {
      const url = new URL(remoteUrl)
      if (
        !['https:', 'ssh:'].includes(url.protocol) ||
        url.password ||
        url.search ||
        url.hash ||
        (url.username && (url.protocol !== 'ssh:' || url.username !== 'git'))
      ) {
        return false
      }
      path = url.pathname.slice(1)
    } catch {
      return false
    }
  }
  const parts = path.split('/')
  return (
    parts.length >= 2 &&
    path.endsWith('.git') &&
    parts.every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part))
  )
}

export function assertGitPushTargetShape(target: unknown): asserts target is GitPushTarget {
  if (typeof target !== 'object' || target === null) {
    throw new Error('Invalid PR push target.')
  }
  const candidate = target as Record<string, unknown>
  assertString(candidate.remoteName, 'remote name')
  assertString(candidate.branchName, 'branch name')
  if (!isSafeGitRemoteName(candidate.remoteName)) {
    throw new Error(`Invalid git remote name: ${candidate.remoteName}`)
  }
  if (!candidate.branchName || candidate.branchName.startsWith('-')) {
    throw new Error(`Invalid git branch name: ${candidate.branchName}`)
  }
  if (candidate.reviewHead !== undefined) {
    const head = candidate.reviewHead as Record<string, unknown> | null
    if (
      !head ||
      (head.provider !== 'github' && head.provider !== 'gitlab') ||
      typeof head.host !== 'string' ||
      !head.host ||
      typeof head.repository !== 'string' ||
      !head.repository.includes('/') ||
      typeof head.branchName !== 'string' ||
      head.branchName !== candidate.branchName
    ) {
      throw new Error('Invalid provider review head identity.')
    }
  }
  if (candidate.remoteUrl !== undefined) {
    assertString(candidate.remoteUrl, 'remote URL')
    if (!isSafePushTargetRemoteUrl(candidate.remoteUrl)) {
      throw new Error('Invalid PR push target remote URL.')
    }
  }
}
