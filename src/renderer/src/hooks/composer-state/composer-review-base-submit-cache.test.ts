// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPrStartPoint } from '../../../../shared/worktree/types'
import { pr, useReviewBaseSelectionFixture } from './composer-review-base-test-fixture'

const resolvePrBase = vi.fn<Window['api']['worktrees']['resolvePrBase']>()
const resolveMrBase = vi.fn<Window['api']['worktrees']['resolveMrBase']>()
let originalApi: PropertyDescriptor | undefined
beforeEach(() => {
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { worktrees: { resolvePrBase, resolveMrBase } }
  })
})
afterEach(() => {
  vi.resetAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('GitHub review base submit cache', () => {
  it('keeps a direct Start-from result without a pending lookup token', async () => {
    const { result } = renderHook(() => useReviewBaseSelectionFixture())
    act(() => result.current.handleBaseBranchPrSelect('direct-review-base', pr))
    const resolution = await result.current.resolvePendingSmartGitHubSubmit()

    expect(resolution).toEqual({ kind: 'none' })
    expect(result.current.baseBranch).toBe('direct-review-base')
    expect(result.current.linkedWorkItem).toMatchObject({ type: 'pr', number: 2 })
    expect(resolvePrBase).not.toHaveBeenCalled()
  })

  it('reuses the completed current selection without another lookup', async () => {
    resolvePrBase.mockResolvedValue({ baseBranch: 'current-review-base' })
    const { result } = renderHook(() => useReviewBaseSelectionFixture())
    await act(async () => {
      result.current.handleSmartGitHubItemSelect(pr)
    })
    const resolution = await result.current.resolvePendingSmartGitHubSubmit()

    expect(resolution).toMatchObject({ kind: 'pr-start-point', baseBranch: 'current-review-base' })
    expect(resolvePrBase).toHaveBeenCalledTimes(1)
  })

  it('still resolves a seeded initial pull request on submit', async () => {
    resolvePrBase.mockResolvedValue({ baseBranch: 'seeded-review-base' })
    const { result } = renderHook(() => useReviewBaseSelectionFixture(pr))
    let resolution
    await act(async () => {
      resolution = await result.current.resolvePendingSmartGitHubSubmit()
    })

    expect(resolution).toMatchObject({ kind: 'pr-start-point', baseBranch: 'seeded-review-base' })
    expect(resolvePrBase).toHaveBeenCalledTimes(1)
    expect(result.current.baseBranch).toBe('seeded-review-base')
  })

  it('still resolves a selected pull request if Create is pressed before its lookup finishes', async () => {
    let complete!: (value: GitHubPrStartPoint) => void
    const pending = new Promise<GitHubPrStartPoint>((resolve) => {
      complete = resolve
    })
    resolvePrBase
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ baseBranch: 'current-review-base' })
    const { result } = renderHook(() => useReviewBaseSelectionFixture())
    act(() => result.current.handleSmartGitHubItemSelect(pr))
    let resolution
    await act(async () => {
      resolution = await result.current.resolvePendingSmartGitHubSubmit()
    })

    expect(resolution).toMatchObject({ kind: 'pr-start-point', baseBranch: 'current-review-base' })
    expect(resolvePrBase).toHaveBeenCalledTimes(2)
    await act(async () => {
      complete({ baseBranch: 'current-review-base' })
      await pending
    })
    expect(result.current.baseBranch).toBe('current-review-base')
  })

  it.each(['source-change', 'base-change', 'repository-change', 'unlink', 'folder-project'])(
    'returns the captured creation result without publishing stale form state after %s',
    async (action) => {
      let finish!: (value: GitHubPrStartPoint) => void
      const submitBase = new Promise<GitHubPrStartPoint>((resolve) => {
        finish = resolve
      })
      resolvePrBase
        .mockReturnValueOnce(new Promise(() => undefined))
        .mockReturnValueOnce(submitBase)
      const { result } = renderHook(() => useReviewBaseSelectionFixture())
      act(() => result.current.handleSmartGitHubItemSelect(pr))
      let pending!: ReturnType<typeof result.current.resolvePendingSmartGitHubSubmit>
      act(() => {
        pending = result.current.resolvePendingSmartGitHubSubmit()
      })
      act(() => {
        if (action === 'source-change') {
          result.current.handleSmartGitHubItemSelect({
            ...pr,
            type: 'issue',
            number: 347,
            url: 'https://github.com/fixture/repo/issues/347'
          })
        }
        if (action === 'base-change') {
          result.current.handleBaseBranchChange('replacement-base')
        }
        if (action === 'repository-change') {
          result.current.handleRepoChange('replacement-repo')
        }
        if (action === 'unlink') {
          result.current.handleRemoveLinkedWorkItem()
        }
        if (action === 'folder-project') {
          result.current.handleProjectChange('project-group:folder')
        }
      })
      const before = {
        source: result.current.linkedWorkItem,
        base: result.current.baseBranch,
        push: result.current.pushTarget,
        compare: result.current.compareBaseRef
      }
      let resolution
      await act(async () => {
        finish({
          baseBranch: 'submitted-review-base',
          compareBaseRef: 'origin/submitted-review-base',
          pushTarget: { remoteName: 'origin', branchName: 'submitted-review-base' }
        })
        resolution = await pending
      })

      expect(resolution).toMatchObject({
        kind: 'pr-start-point',
        baseBranch: 'submitted-review-base',
        linkedPR: 2
      })
      expect({
        source: result.current.linkedWorkItem,
        base: result.current.baseBranch,
        push: result.current.pushTarget,
        compare: result.current.compareBaseRef
      }).toEqual(before)
    }
  )
})
