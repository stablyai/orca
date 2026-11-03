// @vitest-environment happy-dom
import {
  reads,
  store,
  source,
  task,
  useRoutingFixture
} from './task-page-linear-refresh-test-fixtures'
import { reads as issueReadRegistry } from '@/store/slices/linear/linear-issue-read-lifecycle'
import { pendingLinearIssueWrites } from '@/store/slices/linear/linear-issue-publication'
import { deferred } from '@/store/slices/linear-slice-test-harness'
import type { useTaskPageDetailRouting } from '../use-task-page-detail-routing'
import { expect, it } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import { Suspense, startTransition, useLayoutEffect } from 'react'

it('independent urgent clear supersedes an uncommitted nonempty selection', async () => {
  const s = store(),
    context = source('local'),
    blocked = deferred<void>()
  s.setState({ jiraIssueCache: {}, jiraSearchCache: {} })
  let route!: ReturnType<typeof useTaskPageDetailRouting>
  let hold = true
  const seen: string[] = [],
    commits: string[] = []
  function Consumer() {
    const current = useRoutingFixture(context)
    const id = current.selectedLinearIssueId ?? 'none'
    seen.push(id)
    useLayoutEffect(() => {
      route = current
      commits.push(id)
    })
    if (id === 'B' && hold) {
      throw blocked.promise
    }
    return <output data-testid="independent-clear">{id}</output>
  }
  const mounted = render(
    <Suspense fallback={<span>Blocked</span>}>
      <Consumer />
    </Suspense>
  )
  try {
    await act(async () => {
      startTransition(() => route.setSelectedLinearIssue({ ...task('B'), id: 'B' }))
    })
    expect(seen).toContain('B')
    expect(commits).not.toContain('B')
    expect(screen.getByTestId('independent-clear').textContent).toBe('none')
    const initialRequest = route.linearSelectionRequest
    act(() => route.clearSelectedLinearIssue())
    const clearRequest = route.linearSelectionRequest
    expect(clearRequest).not.toBe(initialRequest)
    expect(screen.getByTestId('independent-clear').textContent).toBe('none')
    hold = false
    await act(async () => {
      blocked.resolve()
      await blocked.promise
    })
    expect(screen.getByTestId('independent-clear').textContent).toBe('none')
    expect(route.linearSelectionRequest).toBe(clearRequest)
  } finally {
    mounted.unmount()
    hold = false
    blocked.resolve()
    await blocked.promise
    expect(commits).not.toContain('B')
    expect(pendingLinearIssueWrites.size).toBe(0)
    expect(issueReadRegistry.size).toBe(0)
    expect(reads.detail).toHaveBeenCalledTimes(0)
  }
})

it('same-batch explicit Clear wins while an obsolete observed request cannot clear a newer decision', () => {
  store().setState({ jiraIssueCache: {}, jiraSearchCache: {} })
  const hook = renderHook(() => useRoutingFixture(source('local')))
  const request = hook.result.current.linearSelectionRequest
  act(() => {
    hook.result.current.setSelectedLinearIssue(task())
    hook.result.current.clearSelectedLinearIssue()
  })
  expect(hook.result.current.selectedLinearIssue).toBeNull()
  const clearRequest = hook.result.current.linearSelectionRequest
  expect(clearRequest).not.toBe(request)
  hook.rerender()
  expect(hook.result.current.linearSelectionRequest).toBe(clearRequest)
  act(() => {
    hook.result.current.setSelectedLinearIssue(task())
    hook.result.current.setSelectedLinearIssue(null, { expectedSelection: clearRequest })
  })
  expect(hook.result.current.selectedLinearIssue?.id).toBe(task().id)
  hook.unmount()
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(issueReadRegistry.size).toBe(0)
  expect(reads.detail).not.toHaveBeenCalled()
})
