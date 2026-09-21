// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionHandoffStatus } from '../../../../shared/agent-session-wire'
import { StructuredAgentSessionHandoffChrome } from './StructuredAgentSessionHandoffChrome'

const IDLE_NATIVE: AgentSessionHandoffStatus = {
  owner: 'native',
  direction: null,
  phase: 'idle',
  stage: null,
  operationId: null
}

afterEach(cleanup)

describe('StructuredAgentSessionHandoffChrome', () => {
  it('uses queued-safe admission when the native view still appears idle', () => {
    const onRequest = vi.fn()
    render(
      <StructuredAgentSessionHandoffChrome
        status={IDLE_NATIVE}
        isWorking={false}
        onRequest={onRequest}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open agent TUI' }))

    expect(onRequest).toHaveBeenCalledWith('to-tui', 'after-turn')
  })

  it('offers one Retry action for a recoverable dead TUI owner', () => {
    const onRequest = vi.fn()
    render(
      <StructuredAgentSessionHandoffChrome
        status={{
          owner: 'tui',
          direction: 'to-native',
          phase: 'failed',
          stage: 'old-owner-stopped',
          operationId: '1800000000000-00000000000000000000000000000001',
          error: {
            message: "Couldn't resume chat — the agent terminal still owns this session",
            recoverableOwner: 'tui'
          }
        }}
        isWorking={false}
        onRequest={onRequest}
      />
    )

    expect(screen.queryByRole('button', { name: 'Return to chat' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRequest).toHaveBeenCalledWith('to-native', 'now', 'retry')
  })
})
