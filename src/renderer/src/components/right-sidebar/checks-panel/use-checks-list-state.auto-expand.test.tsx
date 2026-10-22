// @vitest-environment happy-dom

import { StrictMode } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { useChecksListState } from './use-checks-list-state'

afterEach(cleanup)

/** Builds a completed check with the given conclusion. */
function check(name: string, conclusion: PRCheckDetail['conclusion']): PRCheckDetail {
  return { name, status: 'completed', conclusion, url: null }
}

const checks = [check('lint', 'success'), check('unit', 'failure'), check('e2e', 'failure')]

describe('useChecksListState auto-expand', () => {
  it('expands the first failing check when React runs state updaters twice', async () => {
    const { result } = renderHook(
      () =>
        useChecksListState({
          checks,
          checksLoading: false,
          checkDetailsContextKey: 'ctx-1',
          worktreeId: 'wt-1'
        }),
      { wrapper: StrictMode }
    )

    await waitFor(() => expect(result.current.expandedCheckKeys.size).toBe(1))
    const [expandedKey] = [...result.current.expandedCheckKeys]
    expect(expandedKey).toContain('unit')
  })
})
