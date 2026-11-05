// @vitest-environment happy-dom
import {
  mocks,
  answer,
  mutateWith,
  renderOptions,
  REOPENED,
  currentValue
} from './use-structured-agent-session-options.test-fixture'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session/agent-session-wire'
import { act, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

it('refreshes another mounted composer on a mode-only host publication without reading on unrelated changes', async () => {
  resetStructuredAgentSessionStatusFeedsForTests()
  let emit: ((event: AgentSessionStatusEvent) => void) | undefined
  mocks.subscribeStatus.mockImplementation(async (_target, onEvent) => {
    emit = onEvent
    return { unsubscribe: () => {} }
  })
  let interactionMode: 'default' | 'plan' = 'default'
  const read = vi.fn(async () => ({
    models: [],
    current: { interactionMode, acceptedInputSources: { interactionMode: 'saved' } }
  }))
  answer({ options: read })
  const { mutate } = mutateWith(async () => null)
  const first = renderOptions(REOPENED, mutate)
  const second = renderOptions({ ...REOPENED, sessionId: 'second-device' }, mutate)
  await waitFor(() =>
    expect(currentValue(first.result.current.optionSnapshot, 'interactionMode')).toBe('default')
  )
  await waitFor(() =>
    expect(currentValue(second.result.current.optionSnapshot, 'interactionMode')).toBe('default')
  )
  const summary = {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    agent: 'codex',
    status: 'idle' as const,
    latestPrompt: '',
    updatedAt: 1
  }
  await act(async () =>
    emit?.({ type: 'status', session: { ...summary, interactionMode: 'default' } })
  )
  const baseline = read.mock.calls.length
  await act(async () =>
    emit?.({
      type: 'status',
      session: { ...summary, sessionId: 'unrelated', interactionMode: 'plan' }
    })
  )
  await act(async () =>
    emit?.({
      type: 'status',
      session: { ...summary, interactionMode: 'default', latestPrompt: 'transcript changed' }
    })
  )
  expect(read.mock.calls.length).toBe(baseline)
  interactionMode = 'plan'
  await act(async () =>
    emit?.({ type: 'status', session: { ...summary, interactionMode: 'plan' } })
  )
  await waitFor(() =>
    expect(currentValue(first.result.current.optionSnapshot, 'interactionMode')).toBe('plan')
  )
  expect(currentValue(second.result.current.optionSnapshot, 'interactionMode')).toBe('default')
  first.unmount()
  second.unmount()
  resetStructuredAgentSessionStatusFeedsForTests()
  mocks.subscribeStatus.mockImplementation(async () => ({
    unsubscribe: vi.fn()
  }))
})
