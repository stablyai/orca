// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { usePRCheckRefreshOwner } from './use-pr-check-refresh-owner'
import { acceptPRCheckObservation } from '../../../shared/github/complete-pr-check-owner'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
afterEach(cleanup)
const item: GitHubWorkItem = {
  id: 'pr42',
  repoId: 'repo',
  number: 42,
  type: 'pr',
  url: 'https://github.com/acme/widgets/pull/42',
  title: 'PR',
  state: 'open',
  headSha: 'h1',
  updatedAt: '',
  labels: [],
  author: null
}
const summary = {
  state: 'failure' as const,
  total: 101,
  passed: 100,
  failed: 1,
  pending: 0,
  neutral: 0
}
const context = { scope: 'source:r1', complete: true, current: true }
it('retains a refreshed head across parent allocation and sequential refresh, then honors a newer parent observation', () => {
  const view = renderHook(({ parent }) => usePRCheckRefreshOwner(parent), {
    initialProps: { parent: item }
  })
  act(() =>
    view.result.current.onOwnerUpdated(
      acceptPRCheckObservation({ ...item, headSha: 'h2', checksSummary: summary }, null, context)!
    )
  )
  view.rerender({ parent: { ...item } })
  expect(view.result.current.checkOwner.headSha).toBe('h2')
  act(() =>
    view.result.current.onOwnerUpdated(
      acceptPRCheckObservation(
        { ...view.result.current.checkOwner, checksSummary: undefined },
        null,
        context
      )!
    )
  )
  expect(view.result.current.checkOwner.checksSummary).toEqual(summary)
  const newer = acceptPRCheckObservation(
    {
      ...item,
      headSha: 'h2',
      checksSummary: { ...summary, state: 'success', failed: 0, passed: 101 }
    },
    null,
    context
  )!
  view.rerender({ parent: newer })
  expect(view.result.current.checkOwner.checksSummary?.state).toBe('success')
})
it('does not reuse last-good after the producing runtime changes', () => {
  const view = renderHook(() => usePRCheckRefreshOwner(item))
  act(() =>
    view.result.current.onOwnerUpdated(
      acceptPRCheckObservation({ ...item, checksSummary: summary }, null, context)!
    )
  )
  act(() =>
    view.result.current.onOwnerUpdated(
      acceptPRCheckObservation(item, null, { ...context, scope: 'source:r2' })!
    )
  )
  expect(view.result.current.checkOwner.checksSummary).toBeUndefined()
})
