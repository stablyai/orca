// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitHubPrStartPoint } from '../../../../shared/worktree/types'
import { clearSmartGitHubSubmitLookupCacheForTests } from '@/lib/smart-github-submit'
import { pr, useReviewBaseSelectionFixture } from './composer-review-base-test-fixture'

const lookup = vi.fn<Window['api']['gh']['workItem']>()
const resolvePrBase = vi.fn<Window['api']['worktrees']['resolvePrBase']>()
let originalApi: PropertyDescriptor | undefined
const issue: GitHubWorkItem = {
  ...pr,
  type: 'issue',
  title: 'Old review',
  url: 'https://github.com/fixture/repo/issues/2'
}
beforeEach(() => {
  clearSmartGitHubSubmitLookupCacheForTests()
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh: { workItem: lookup }, worktrees: { resolvePrBase } }
  })
})
afterEach(() => {
  vi.resetAllMocks()
  clearSmartGitHubSubmitLookupCacheForTests()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})
function deferredLookup() {
  let finish!: (value: GitHubWorkItem) => void
  const pending = new Promise<GitHubWorkItem>((resolve) => {
    finish = resolve
  })
  lookup.mockReturnValue(pending)
  return { pending, finish }
}
function snapshot(state: ReturnType<typeof useReviewBaseSelectionFixture>) {
  const {
    name,
    linkedWorkItem,
    baseBranch,
    pushTarget,
    compareBaseRef,
    repoId,
    branchNameOverride
  } = state
  return {
    name,
    linkedWorkItem,
    baseBranch,
    pushTarget,
    compareBaseRef,
    repoId,
    branchNameOverride
  }
}

describe('raw GitHub submit publication ownership', () => {
  it.each([
    'source-change',
    'same-number-selection',
    'manual-name',
    'manual-branch',
    'cleared-name',
    'unlink',
    'base-change',
    'repository-change',
    'folder-project',
    'smart-branch'
  ])('returns its captured result without overwriting the form after %s', async (action) => {
    const old = deferredLookup()
    const { result } = renderHook(() => useReviewBaseSelectionFixture())
    act(() => result.current.handleNameValueChange('#2'))
    let submitted!: ReturnType<typeof result.current.resolvePendingSmartGitHubSubmit>
    act(() => {
      submitted = result.current.resolvePendingSmartGitHubSubmit()
    })
    act(() => {
      if (action === 'source-change' || action === 'same-number-selection') {
        const number = action === 'same-number-selection' ? 2 : 347
        result.current.handleSmartGitHubItemSelect({
          ...issue,
          number,
          title: 'Current task',
          url: `https://github.com/fixture/repo/issues/${number}`
        })
      }
      if (action === 'manual-name' || action === 'cleared-name') {
        result.current.handleNameValueChange(action === 'manual-name' ? '002' : '')
      }
      if (action === 'manual-branch') {
        result.current.handleBranchNameOverrideChange('manual-later-branch')
      }
      if (action === 'unlink') {
        result.current.handleRemoveLinkedWorkItem()
      }
      if (action === 'base-change') {
        result.current.handleBaseBranchChange('replacement-base')
      }
      if (action === 'repository-change') {
        result.current.handleRepoChange('replacement-repo')
      }
      if (action === 'folder-project') {
        result.current.handleProjectChange('project-group:folder')
      }
      if (action === 'smart-branch') {
        result.current.handleSmartBranchSelect('origin/current-branch', 'current-branch')
      }
    })
    const before = snapshot(result.current)
    let resolution
    await act(async () => {
      old.finish(issue)
      resolution = await submitted
    })

    expect(resolution).toMatchObject({ kind: 'metadata-only', linkedIssueNumber: 2 })
    expect(snapshot(result.current)).toEqual(before)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('publishes an active lookup when the query stays the same', async () => {
    const old = deferredLookup()
    const { result } = renderHook(() => useReviewBaseSelectionFixture())
    act(() => result.current.handleNameValueChange('#2'))
    let submitted!: ReturnType<typeof result.current.resolvePendingSmartGitHubSubmit>
    act(() => {
      submitted = result.current.resolvePendingSmartGitHubSubmit()
    })
    act(() => result.current.handleNameValueChange('#2'))
    await act(async () => {
      old.finish(issue)
      await submitted
    })

    expect(result.current.name).toBe('old-review')
    expect(result.current.linkedWorkItem).toMatchObject({ number: 2, title: 'Old review' })
  })

  it('keeps lookup deduplication for a second submission of the same query', async () => {
    const old = deferredLookup()
    const { result } = renderHook(() => useReviewBaseSelectionFixture())
    act(() => result.current.handleNameValueChange('#2'))
    let first!: ReturnType<typeof result.current.resolvePendingSmartGitHubSubmit>
    let second!: typeof first
    act(() => {
      first = result.current.resolvePendingSmartGitHubSubmit()
      second = result.current.resolvePendingSmartGitHubSubmit()
    })
    let resolutions
    await act(async () => {
      old.finish(issue)
      resolutions = await Promise.all([first, second])
    })

    expect(resolutions).toEqual([
      expect.objectContaining({ linkedIssueNumber: 2 }),
      expect.objectContaining({ linkedIssueNumber: 2 })
    ])
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(result.current.name).toBe('old-review')
    expect(result.current.linkedWorkItem).toMatchObject({ number: 2 })
  })

  it.each(['active', 'source-change'])(
    'retains the captured PR lookup result while publishing only the %s form',
    async (action) => {
      const itemLookup = deferredLookup()
      let finishBase!: (value: GitHubPrStartPoint) => void
      resolvePrBase.mockReturnValue(
        new Promise<GitHubPrStartPoint>((resolve) => {
          finishBase = resolve
        })
      )
      const { result } = renderHook(() => useReviewBaseSelectionFixture())
      act(() => result.current.handleNameValueChange('#2'))
      let submitted!: ReturnType<typeof result.current.resolvePendingSmartGitHubSubmit>
      act(() => {
        submitted = result.current.resolvePendingSmartGitHubSubmit()
      })
      await act(async () => {
        itemLookup.finish(pr)
        await itemLookup.pending
      })
      expect(resolvePrBase).toHaveBeenCalledTimes(1)
      if (action === 'source-change') {
        act(() =>
          result.current.handleSmartGitHubItemSelect({
            ...issue,
            number: 347,
            title: 'Current task',
            url: 'https://github.com/fixture/repo/issues/347'
          })
        )
      }
      const before = snapshot(result.current)
      let resolution
      await act(async () => {
        finishBase({ baseBranch: 'submitted-review-base' })
        resolution = await submitted
      })

      expect(resolution).toMatchObject({ kind: 'pr-start-point', linkedPR: 2 })
      if (action === 'active') {
        expect(result.current.baseBranch).toBe('submitted-review-base')
        expect(result.current.linkedWorkItem).toMatchObject({ type: 'pr', number: 2 })
      } else {
        expect(snapshot(result.current)).toEqual(before)
      }
    }
  )
})
