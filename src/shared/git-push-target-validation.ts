import type { GitPushTarget } from './types'

const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const GITHUB_CLONE_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/
const GITHUB_SSH_URL = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid PR push target ${name}.`)
  }
}

export function assertGitPushTargetShape(target: unknown): asserts target is GitPushTarget {
  if (typeof target !== 'object' || target === null) {
    throw new Error('Invalid PR push target.')
  }
  const candidate = target as Record<string, unknown>
  assertString(candidate.remoteName, 'remote name')
  assertString(candidate.branchName, 'branch name')
  if (
    !SAFE_REMOTE_NAME.test(candidate.remoteName) ||
    candidate.remoteName === '.' ||
    candidate.remoteName === '..'
  ) {
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
