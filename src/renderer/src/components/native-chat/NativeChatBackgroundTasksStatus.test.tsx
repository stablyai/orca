// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'

afterEach(cleanup)

const TASKS: AgentSessionBackgroundTask[] = [
  { id: 'codex-agent:child-1', kind: 'agent', description: 'count_a' },
  { id: 'codex-command:exec-1', kind: 'command', description: 'sleep 90' }
]

function renderStrip(props: { supportsTaskStop: boolean; supportsStopAll: boolean }): {
  onStop: ReturnType<typeof vi.fn>
} {
  const onStop = vi.fn()
  render(
    <NativeChatBackgroundTasksStatus
      tasks={TASKS}
      supportsTaskStop={props.supportsTaskStop}
      supportsStopAll={props.supportsStopAll}
      stoppingTaskIds={new Set()}
      stoppingAll={false}
      onStop={onStop}
    />
  )
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  return { onStop }
}

describe('NativeChatBackgroundTasksStatus stop affordances', () => {
  it('offers a per-task stop on a host that accepts targeted stops', () => {
    renderStrip({ supportsTaskStop: true, supportsStopAll: true })
    expect(screen.getByLabelText('Stop count_a')).toBeInTheDocument()
    expect(screen.queryByLabelText('Stop background tasks')).not.toBeInTheDocument()
  })

  it('falls back to a stop-all on a host that only accepts an untargeted stop', () => {
    renderStrip({ supportsTaskStop: false, supportsStopAll: true })
    expect(screen.getByLabelText('Stop background tasks')).toBeInTheDocument()
  })

  it('offers no stop at all when the provider exposes none', () => {
    // Codex: a Stop button here would be a control that cannot act.
    renderStrip({ supportsTaskStop: false, supportsStopAll: false })
    expect(screen.queryByLabelText('Stop background tasks')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Stop count_a')).not.toBeInTheDocument()
    expect(screen.getByText('count_a')).toBeInTheDocument()
    expect(screen.getByText('sleep 90')).toBeInTheDocument()
  })
})
