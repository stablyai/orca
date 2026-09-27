// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'

afterEach(cleanup)

const NO_TASKS = {
  show: false,
  isMonitoring: false,
  tasks: [],
  settledTasks: [],
  supportsStop: false,
  supportsStopAll: false
}

function renderStatus(startupPhase: 'starting' | 'ready' | null) {
  return render(
    <NativeChatStructuredSessionStatus
      sessionId="session-1"
      agentLabel="Claude"
      startupPhase={startupPhase}
      error={null}
      composerError={null}
      isVisible
      backgroundTasks={NO_TASKS}
      stopBackgroundTask={vi.fn(async () => undefined)}
    />
  )
}

describe('NativeChatStructuredSessionStatus', () => {
  it('says the agent is still starting while the host reports a starting child', () => {
    renderStatus('starting')
    expect(screen.getByText(/Claude is still starting/)).toBeInTheDocument()
    expect(screen.getByText(/close this chat/)).toBeInTheDocument()
  })

  it('shows nothing about startup once the child is ready or the host has no word', () => {
    renderStatus('ready')
    expect(screen.queryByText(/still starting/)).not.toBeInTheDocument()
    cleanup()
    renderStatus(null)
    expect(screen.queryByText(/still starting/)).not.toBeInTheDocument()
  })
})
