// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPrStartPoint } from '../../../../shared/worktree/types'
import { pr, mr, useReviewBaseSelectionFixture } from './composer-review-base-test-fixture'

let originalApi: PropertyDescriptor | undefined
const resolvePrBase = vi.fn<Window['api']['worktrees']['resolvePrBase']>()
const resolveMrBase = vi.fn<Window['api']['worktrees']['resolveMrBase']>()

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

function deferred() {
  let resolve!: (value: GitHubPrStartPoint) => void
  const promise = new Promise<GitHubPrStartPoint>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('name ownership while resolving review bases', () => {
  it.each(['github', 'gitlab'])(
    'keeps an Advanced name while %s resolves its base',
    async (provider) => {
      const pending = deferred()
      resolvePrBase.mockReturnValue(pending.promise)
      resolveMrBase.mockReturnValue(pending.promise)
      const { result } = renderHook(useReviewBaseSelectionFixture)
      act(() => {
        if (provider === 'github') {
          result.current.handleSmartGitHubItemSelect(pr)
        } else {
          result.current.handleSmartGitLabItemSelect(mr)
        }
      })
      act(() => result.current.handleNameValueChange('002'))
      await act(async () => {
        pending.resolve({ baseBranch: 'feature/export' })
        await pending.promise
      })

      expect(result.current.name).toBe('002')
      expect(result.current.linkedWorkItem).toMatchObject({ provider, number: 2 })
      expect(result.current.baseBranch).toBe('feature/export')
    }
  )

  it.each(['github', 'gitlab'])(
    'still links and auto-names a direct %s Start-from selection',
    (provider) => {
      const { result } = renderHook(useReviewBaseSelectionFixture)
      act(() => {
        if (provider === 'github') {
          result.current.handleBaseBranchPrSelect('feature/export', pr)
        } else {
          result.current.handleBaseBranchMrSelect('feature/export', mr)
        }
      })

      expect(result.current.name).toBe('fix-export')
      expect(result.current.linkedWorkItem).toMatchObject({ provider, number: 2 })
    }
  )
})
