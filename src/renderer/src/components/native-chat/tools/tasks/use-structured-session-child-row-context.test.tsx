// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})

import { useAppStore } from '@/store'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { useStructuredSessionChildRowContext } from './use-structured-session-child-row-context'

afterEach(cleanup)

it('reads current child evidence when a hidden strip becomes visible', () => {
  const paneKey = 'parent:11111111-1111-4111-8111-111111111111'
  const parent = {
    paneKey,
    agentType: 'codex' as const,
    state: 'working' as const,
    prompt: 'Task',
    structuredHostOwned: true as const,
    updatedAt: 1000,
    stateStartedAt: 1000,
    stateHistory: []
  }
  useAppStore.setState({ agentStatusByPaneKey: acceptedAgentStatuses([[paneKey, parent]]) })
  const view = renderHook(({ active }) => useStructuredSessionChildRowContext(paneKey, active), {
    initialProps: { active: false }
  })
  expect(view.result.current).toBeUndefined()
  act(() => {
    useAppStore.setState({
      agentStatusByPaneKey: useAppStore
        .getState()
        .agentStatusByPaneKey.replace([
          [paneKey, { ...parent, updatedAt: 2000, subagentObservation: 'unverifiable' }]
        ])
    })
  })
  view.rerender({ active: true })
  expect(view.result.current).toEqual({
    parentEvidenceFresh: true,
    transportObservation: 'unverifiable',
    parentObservedAt: 2000,
    hostClockOffsetMs: 0
  })
})
