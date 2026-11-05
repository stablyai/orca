import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRFileContents } from '../../../../../shared/github/pull-request-types'
import { evictPRFileContentRequest, loadPRFileContents } from './file-content'

const args = {
  repoPath: '/repo',
  repoId: 'repo-id',
  prNumber: 42,
  file: {
    path: 'src/file.ts',
    status: 'modified' as const,
    additions: 1,
    deletions: 1,
    isBinary: false
  },
  headSha: 'head',
  baseSha: 'base'
}

function deferredContents(): {
  promise: Promise<GitHubPRFileContents>
  resolve: (contents: GitHubPRFileContents) => void
} {
  let resolve!: (contents: GitHubPRFileContents) => void
  const promise = new Promise<GitHubPRFileContents>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('PR file content cache', () => {
  const prFileContents = vi.fn()

  beforeEach(() => {
    prFileContents.mockReset()
    vi.stubGlobal('window', { api: { gh: { prFileContents } } })
  })

  it('starts a new request after a pending request is evicted', async () => {
    const first = deferredContents()
    const retry = deferredContents()
    prFileContents.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)

    const firstRequest = loadPRFileContents(args)
    expect(loadPRFileContents(args)).toBe(firstRequest)

    evictPRFileContentRequest(args, firstRequest)
    const retryRequest = loadPRFileContents(args)

    expect(retryRequest).not.toBe(firstRequest)
    expect(prFileContents).toHaveBeenCalledTimes(2)

    first.resolve({
      original: 'stale',
      modified: 'stale',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    await firstRequest

    expect(loadPRFileContents(args)).toBe(retryRequest)

    retry.resolve({
      original: 'fresh',
      modified: 'fresh',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    await expect(retryRequest).resolves.toMatchObject({ modified: 'fresh' })
  })
})
