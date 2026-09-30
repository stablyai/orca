// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NativeChatStructuredSessionStatus,
  SLOW_STARTUP_NOTICE_DELAY_MS
} from './NativeChatStructuredSessionStatus'
import { STATUS_MIN_VISIBLE_MS } from '@/lib/delayed-status'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NO_TASKS = {
  show: false,
  isMonitoring: false,
  tasks: [],
  settledTasks: [],
  supportsStop: false,
  supportsStopAll: false
}

function statusElement(
  startupPhase: 'starting' | 'ready' | null,
  sessionId = 'session-1',
  startupChildKey: string | null = null
) {
  return (
    <NativeChatStructuredSessionStatus
      sessionId={sessionId}
      agentLabel="Claude"
      startupPhase={startupPhase}
      startupChildKey={startupChildKey}
      error={null}
      composerError={null}
      isVisible
      backgroundTasks={NO_TASKS}
      stopBackgroundTask={vi.fn(async () => undefined)}
    />
  )
}

function renderStatus(startupPhase: 'starting' | 'ready' | null) {
  return render(statusElement(startupPhase))
}

describe('NativeChatStructuredSessionStatus', () => {
  it('says the agent is still starting once startup runs long', () => {
    vi.useFakeTimers()
    renderStatus('starting')
    act(() => vi.advanceTimersByTime(SLOW_STARTUP_NOTICE_DELAY_MS))
    expect(screen.getByText(/Claude is still starting/)).toBeInTheDocument()
    expect(screen.getByText(/close this chat/)).toBeInTheDocument()
  })

  it('restarts the grace period for a relaunch or another session', () => {
    vi.useFakeTimers()
    const view = renderStatus('starting')
    act(() => vi.advanceTimersByTime(SLOW_STARTUP_NOTICE_DELAY_MS))
    view.rerender(statusElement('ready'))
    act(() => vi.advanceTimersByTime(STATUS_MIN_VISIBLE_MS))
    expect(screen.queryByText(/still starting/)).not.toBeInTheDocument()
    view.rerender(statusElement('starting'))
    expect(screen.queryByText(/still starting/)).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(SLOW_STARTUP_NOTICE_DELAY_MS))
    expect(screen.getByText(/still starting/)).toBeInTheDocument()
    view.rerender(statusElement('starting', 'session-2'))
    expect(screen.queryByText(/still starting/)).not.toBeInTheDocument()
  })

  it('resets for a replacement child even when no intermediate phase reaches the view', () => {
    vi.useFakeTimers()
    const view = render(statusElement('starting', 'session-1', 'child-1'))
    act(() => vi.advanceTimersByTime(SLOW_STARTUP_NOTICE_DELAY_MS))
    view.rerender(statusElement('starting', 'session-1', 'child-2'))
    expect(screen.queryByText(/still starting/)).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(SLOW_STARTUP_NOTICE_DELAY_MS - 1))
    expect(screen.queryByText(/still starting/)).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText(/still starting/)).toBeInTheDocument()
  })

  it('shows nothing about startup once the child is ready or the host has no word', () => {
    renderStatus('ready')
    expect(screen.queryByText(/still starting/)).not.toBeInTheDocument()
    cleanup()
    renderStatus(null)
    expect(screen.queryByText(/still starting/)).not.toBeInTheDocument()
  })
})
