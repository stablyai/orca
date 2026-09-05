import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoOption, RepoSlugTarget } from './smart-workspace-name-field-model'
import { findMatchingRepoForSlug } from './smart-workspace-repo-slug'

const repoSlug = vi.fn()
const repoUpstream = vi.fn()

// @ts-expect-error focused preload mock
globalThis.window = { api: { gh: { repoSlug, repoUpstream } } }

function makeRepo(overrides: Partial<RepoOption> = {}): RepoOption {
  return {
    id: 'repo-1',
    path: '/workspace/repo-1',
    displayName: 'repo-1',
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'local',
    ...overrides
  } as RepoOption
}

function makeTarget(id: string, overrides: Partial<RepoOption> = {}): RepoSlugTarget {
  return {
    repo: makeRepo({
      id,
      path: `/workspace/${id}`,
      displayName: id,
      ...overrides
    }),
    sourceContext: null
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('findMatchingRepoForSlug', () => {
  beforeEach(() => {
    repoSlug.mockReset()
    repoUpstream.mockReset()
  })

  it('probes unresolved upstream identities concurrently', async () => {
    const gate = deferred<{ owner: string; repo: string } | null>()
    const started: string[] = []
    repoSlug.mockImplementation(async ({ repoId }: { repoId: string }) => ({
      owner: `${repoId}-owner`,
      repo: repoId
    }))
    repoUpstream.mockImplementation(async ({ repoId }: { repoId: string }) => {
      started.push(repoId)
      return gate.promise
    })

    const resultPromise = findMatchingRepoForSlug(
      [makeTarget('a'), makeTarget('b'), makeTarget('c')],
      { owner: 'acme', repo: 'widgets' },
      new Map()
    )

    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']))
    gate.resolve(null)
    await expect(resultPromise).resolves.toBeNull()
    expect(repoUpstream).toHaveBeenCalledTimes(3)
  })

  it('returns the first exact origin match without probing upstream', async () => {
    repoSlug.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'later-origin') {
        return { owner: 'acme', repo: 'widgets' }
      }
      return { owner: `${repoId}-owner`, repo: repoId }
    })
    repoUpstream.mockResolvedValue({ owner: 'acme', repo: 'widgets' })

    await expect(
      findMatchingRepoForSlug(
        [makeTarget('early-fork'), makeTarget('later-origin')],
        { owner: 'acme', repo: 'widgets' },
        new Map()
      )
    ).resolves.toMatchObject({ repo: { id: 'later-origin' } })
    expect(repoUpstream).not.toHaveBeenCalled()
  })

  it('selects the first matching upstream target in target order after concurrent probes', async () => {
    const first = deferred<{ owner: string; repo: string } | null>()
    const second = deferred<{ owner: string; repo: string } | null>()
    repoSlug.mockImplementation(async ({ repoId }: { repoId: string }) => ({
      owner: `${repoId}-owner`,
      repo: repoId
    }))
    repoUpstream.mockImplementation(async ({ repoId }: { repoId: string }) =>
      repoId === 'first' ? first.promise : second.promise
    )

    const resultPromise = findMatchingRepoForSlug(
      [makeTarget('first'), makeTarget('second')],
      { owner: 'acme', repo: 'widgets' },
      new Map()
    )
    await vi.waitFor(() => expect(repoUpstream).toHaveBeenCalledTimes(2))
    second.resolve({ owner: 'acme', repo: 'widgets' })
    first.resolve({ owner: 'acme', repo: 'widgets' })

    await expect(resultPromise).resolves.toMatchObject({ repo: { id: 'first' } })
  })

  it('does not live-probe a persisted non-fork while probing later unresolved targets', async () => {
    const gate = deferred<{ owner: string; repo: string } | null>()
    repoSlug.mockImplementation(async ({ repoId }: { repoId: string }) => ({
      owner: `${repoId}-owner`,
      repo: repoId
    }))
    repoUpstream.mockImplementation(async () => gate.promise)

    const resultPromise = findMatchingRepoForSlug(
      [makeTarget('resolved', { upstream: null }), makeTarget('unresolved')],
      { owner: 'acme', repo: 'widgets' },
      new Map()
    )
    await vi.waitFor(() => expect(repoUpstream).toHaveBeenCalledTimes(1))
    expect(repoUpstream).toHaveBeenCalledExactlyOnceWith({
      repoPath: '/workspace/unresolved',
      repoId: 'unresolved'
    })
    gate.resolve(null)
    await expect(resultPromise).resolves.toBeNull()
  })
})
