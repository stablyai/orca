import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSmartGitHubSubmitLookupCacheForTests,
  getSmartGitHubSubmitIntent,
  getSmartGitHubSubmitResolution,
  getSmartGitHubSubmitLookupCacheSizeForTests,
  lookupSmartGitHubSubmitItem
} from './smart-github-submit'

describe('getSmartGitHubSubmitIntent', () => {
  it('treats GitHub issue and pull URLs as submit-time source intent', () => {
    expect(getSmartGitHubSubmitIntent('https://github.com/stablyai/orca/pull/2049')).toEqual({
      kind: 'link',
      owner: 'stablyai',
      repo: 'orca',
      number: 2049,
      type: 'pr'
    })
    expect(getSmartGitHubSubmitIntent('https://github.com/stablyai/orca/issues/2050')).toEqual({
      kind: 'link',
      owner: 'stablyai',
      repo: 'orca',
      number: 2050,
      type: 'issue'
    })
  })

  it('finds a GitHub item URL embedded in a short instruction', () => {
    expect(
      getSmartGitHubSubmitIntent(
        'https://github.com/mvanhorn/cli-printing-press/issues/2635 and fix it'
      )
    ).toEqual({
      kind: 'link',
      owner: 'mvanhorn',
      repo: 'cli-printing-press',
      number: 2635,
      type: 'issue'
    })
  })

  it('finds an embedded GitHub item URL when prose punctuation touches the URL', () => {
    expect(
      getSmartGitHubSubmitIntent('review (https://github.com/stablyai/orca/pull/2049), please')
    ).toEqual({
      kind: 'link',
      owner: 'stablyai',
      repo: 'orca',
      number: 2049,
      type: 'pr'
    })

    expect(getSmartGitHubSubmitIntent('fix https://github.com/stablyai/orca/issues/2050.')).toEqual(
      {
        kind: 'link',
        owner: 'stablyai',
        repo: 'orca',
        number: 2050,
        type: 'issue'
      }
    )
  })

  it('treats #number as source intent but leaves plain numbers as names', () => {
    expect(getSmartGitHubSubmitIntent('#2049')).toEqual({
      kind: 'hash-number',
      number: 2049
    })
    expect(getSmartGitHubSubmitIntent('2049')).toBeNull()
  })
})

describe('lookupSmartGitHubSubmitItem', () => {
  beforeEach(() => {
    clearSmartGitHubSubmitLookupCacheForTests()
  })

  it('reuses an in-flight direct URL lookup for the same repo and intent', async () => {
    const item = {
      id: 'pr-2049',
      type: 'pr' as const,
      number: 2049,
      title: 'Fix smart resolution delay',
      state: 'open' as const,
      url: 'https://github.com/stablyai/orca/pull/2049',
      labels: [],
      updatedAt: '2026-05-26T00:00:00.000Z',
      author: 'octocat',
      repoId: 'repo-1'
    }
    const workItemByOwnerRepo = vi.fn().mockResolvedValue(item)
    const workItem = vi.fn()
    const intent = {
      kind: 'link' as const,
      owner: 'stablyai',
      repo: 'orca',
      number: 2049,
      type: 'pr' as const
    }

    const first = lookupSmartGitHubSubmitItem({
      repoId: 'repo-1',
      repoPath: '/repo',
      intent,
      workItem,
      workItemByOwnerRepo
    })
    const second = lookupSmartGitHubSubmitItem({
      repoId: 'repo-1',
      repoPath: '/repo',
      intent,
      workItem,
      workItemByOwnerRepo
    })

    await expect(first).resolves.toEqual(item)
    await expect(second).resolves.toEqual(item)
    expect(workItemByOwnerRepo).toHaveBeenCalledTimes(1)
    expect(workItem).not.toHaveBeenCalled()
  })

  it('scopes direct URL cache entries by repo path', async () => {
    const intent = {
      kind: 'link' as const,
      owner: 'stablyai',
      repo: 'orca',
      number: 2049,
      type: 'pr' as const
    }
    const firstItem = {
      id: 'pr-2049-a',
      type: 'pr' as const,
      number: 2049,
      title: 'First repo path',
      state: 'open' as const,
      url: 'https://github.com/stablyai/orca/pull/2049',
      labels: [],
      updatedAt: '2026-05-26T00:00:00.000Z',
      author: 'octocat',
      repoId: 'repo-1'
    }
    const secondItem = { ...firstItem, id: 'pr-2049-b', title: 'Second repo path' }
    const workItemByOwnerRepo = vi
      .fn()
      .mockResolvedValueOnce(firstItem)
      .mockResolvedValueOnce(secondItem)
    const workItem = vi.fn()

    await expect(
      lookupSmartGitHubSubmitItem({
        repoId: 'repo-1',
        repoPath: '/repo-a',
        intent,
        workItem,
        workItemByOwnerRepo
      })
    ).resolves.toEqual(firstItem)
    await expect(
      lookupSmartGitHubSubmitItem({
        repoId: 'repo-1',
        repoPath: '/repo-b',
        intent,
        workItem,
        workItemByOwnerRepo
      })
    ).resolves.toEqual(secondItem)
    await expect(
      lookupSmartGitHubSubmitItem({
        repoId: 'repo-1',
        repoPath: '/repo-a',
        intent,
        workItem,
        workItemByOwnerRepo
      })
    ).resolves.toEqual(firstItem)
    expect(workItemByOwnerRepo).toHaveBeenCalledTimes(2)
    expect(workItem).not.toHaveBeenCalled()
  })

  it('evicts rejected direct URL lookups so immediate retries can recover', async () => {
    const item = {
      id: 'pr-2049',
      type: 'pr' as const,
      number: 2049,
      title: 'Recovered lookup',
      state: 'open' as const,
      url: 'https://github.com/stablyai/orca/pull/2049',
      labels: [],
      updatedAt: '2026-05-26T00:00:00.000Z',
      author: 'octocat',
      repoId: 'repo-1'
    }
    const workItemByOwnerRepo = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary GitHub failure'))
      .mockResolvedValueOnce(item)
    const workItem = vi.fn()
    const intent = {
      kind: 'link' as const,
      owner: 'stablyai',
      repo: 'orca',
      number: 2049,
      type: 'pr' as const
    }
    const lookup = () =>
      lookupSmartGitHubSubmitItem({
        repoId: 'repo-1',
        repoPath: '/repo',
        intent,
        workItem,
        workItemByOwnerRepo
      })

    await expect(lookup()).rejects.toThrow('temporary GitHub failure')
    await expect(lookup()).resolves.toEqual(item)
    expect(workItemByOwnerRepo).toHaveBeenCalledTimes(2)
    expect(workItem).not.toHaveBeenCalled()
  })

  it('prunes expired distinct lookup entries on later lookups', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    const workItemByOwnerRepo = vi.fn()
    const workItem = vi.fn().mockImplementation(({ number }) =>
      Promise.resolve({
        id: `issue-${number}`,
        type: 'issue' as const,
        number,
        title: `Issue ${number}`,
        state: 'open' as const,
        url: `https://github.com/stablyai/orca/issues/${number}`,
        labels: [],
        updatedAt: '2026-05-26T00:00:00.000Z',
        author: 'octocat',
        repoId: 'repo-1'
      })
    )

    try {
      nowSpy.mockReturnValue(1_000)
      await lookupSmartGitHubSubmitItem({
        repoId: 'repo-1',
        repoPath: '/repo',
        intent: { kind: 'hash-number', number: 2049 },
        workItem,
        workItemByOwnerRepo
      })
      expect(getSmartGitHubSubmitLookupCacheSizeForTests()).toBe(1)

      nowSpy.mockReturnValue(62_000)
      await lookupSmartGitHubSubmitItem({
        repoId: 'repo-1',
        repoPath: '/repo',
        intent: { kind: 'hash-number', number: 2050 },
        workItem,
        workItemByOwnerRepo
      })

      expect(getSmartGitHubSubmitLookupCacheSizeForTests()).toBe(1)
      expect(workItem).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('getSmartGitHubSubmitResolution', () => {
  it('uses the resolved PR title for workspace name, display name, and linked PR metadata', () => {
    expect(
      getSmartGitHubSubmitResolution({
        type: 'pr',
        number: 2049,
        title: 'Fix smart resolution delay',
        url: 'https://github.com/stablyai/orca/pull/2049'
      })
    ).toEqual({
      workspaceName: 'fix-smart-resolution-delay',
      displayName: 'Fix smart resolution delay',
      linkedWorkItem: {
        type: 'pr',
        number: 2049,
        title: 'Fix smart resolution delay',
        url: 'https://github.com/stablyai/orca/pull/2049'
      },
      linkedIssueNumber: null,
      linkedPR: 2049
    })
  })

  it('strips duplicated issue prefixes while preserving linked issue metadata', () => {
    const resolution = getSmartGitHubSubmitResolution({
      type: 'issue',
      number: 2050,
      title: 'Issue #2050: Make create feel instant',
      url: 'https://github.com/stablyai/orca/issues/2050'
    })

    expect(resolution.workspaceName).toBe('make-create-feel-instant')
    expect(resolution.displayName).toBe('Make create feel instant')
    expect(resolution.linkedIssueNumber).toBe(2050)
    expect(resolution.linkedPR).toBeNull()
  })
})
