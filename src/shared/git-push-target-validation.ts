import type { GitPushTarget } from './types'

const SAFE_REMOTE_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const GITHUB_CLONE_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/
const GITHUB_SSH_URL = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid PR push target ${name}.`)
  }
}

function isSafeRemoteName(remoteName: string): boolean {
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

export function assertGitPushTargetShape(target: unknown): asserts target is GitPushTarget {
  if (typeof target !== 'object' || target === null) {
    throw new Error('Invalid PR push target.')
  }
  const candidate = target as Record<string, unknown>
  assertString(candidate.remoteName, 'remote name')
  assertString(candidate.branchName, 'branch name')
  if (!isSafeRemoteName(candidate.remoteName)) {
    throw new Error(`Invalid git remote name: ${candidate.remoteName}`)
  }
  if (!candidate.branchName || candidate.branchName.startsWith('-')) {
    throw new Error(`Invalid git branch name: ${candidate.branchName}`)
  }
  if (candidate.remoteUrl !== undefined) {
    assertString(candidate.remoteUrl, 'remote URL')
    if (!(GITHUB_CLONE_URL.test(candidate.remoteUrl) || GITHUB_SSH_URL.test(candidate.remoteUrl))) {
      throw new Error('Invalid PR push target remote URL.')
    }
  }
}
