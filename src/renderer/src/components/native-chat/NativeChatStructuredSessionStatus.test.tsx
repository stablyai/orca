// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionCancelResult } from '../../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import { structuredSessionBackgroundTasksView } from '../../../../shared/structured-session-background-tasks-view'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'

vi.mock('./use-structured-session-child-row-context', () => ({
  useStructuredSessionChildRowContext: () => undefined
}))

afterEach(cleanup)

function helper(invocation: AgentChildWorkView['invocation']): AgentChildWorkView {
  return {
    id: 'helper',
    providerId: 'thread-helper',
    kind: 'agent',
    description: 'audit_build',
    state: 'working',
    membership: 'live',
    firstObservedAt: Date.now() - 65_000,
    observedAt: Date.now() - 1_000,
    stoppable: true,
    invocation
  }
}

describe('NativeChatStructuredSessionStatus', () => {
  it("offers Stop again on a helper's next run, which reuses the stopped run's row id", async () => {
    let finish: (result: AgentSessionCancelResult) => void = () => {}
    const stopBackgroundTask = vi.fn(
      () => new Promise<AgentSessionCancelResult>((resolve) => (finish = resolve))
    )
    const strip = (children: AgentChildWorkView[]) => (
      <NativeChatStructuredSessionStatus
        sessionId="session-1"
        paneKey="pane-1"
        isVisible
        backgroundTasks={structuredSessionBackgroundTasksView(
          { state: 'monitoring', supportsTaskStop: true, children },
          null
        )}
        stopBackgroundTask={stopBackgroundTask}
      />
    )
    const { rerender } = render(strip([helper({ invocationId: 'turn-1', generation: 1 })]))
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    fireEvent.click(screen.getByLabelText('Stop audit_build'))
    await act(async () => finish({ cancelled: true }))
    expect(screen.getByLabelText('Stop audit_build')).toBeDisabled()

    // The helper's next run, with no render between: same provider id, a new invocation.
    rerender(strip([helper({ invocationId: 'turn-2', generation: 2 })]))
    expect(screen.getByLabelText('Stop audit_build')).toBeEnabled()
  })
})
