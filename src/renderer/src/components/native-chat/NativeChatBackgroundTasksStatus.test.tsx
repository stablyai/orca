// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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
      isVisible
      tasks={TASKS}
      settledTasks={[]}
      indicatorActive
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

describe('background-tasks strip header', () => {
  function renderHeader(tasks: AgentSessionBackgroundTask[]): HTMLElement {
    render(
      <NativeChatBackgroundTasksStatus
        isVisible
        tasks={tasks}
        settledTasks={[]}
        indicatorActive
        supportsTaskStop={false}
        supportsStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={() => {}}
      />
    )
    return screen.getByRole('button', { expanded: false })
  }

  it('leads each kind segment with that kind icon and keeps the counts in the accessible name', () => {
    const header = renderHeader([
      { id: 'a1', kind: 'agent' },
      { id: 'a2', kind: 'agent' },
      { id: 'a3', kind: 'agent' },
      { id: 'm1', kind: 'monitor' }
    ])
    expect(header).toHaveAttribute('aria-label', '3 agents · 1 monitor')
    expect(header.querySelector('.lucide-bot')).toBeInTheDocument()
    // Heartbeat, the same glyph the agent sidebar shows for monitoring.
    expect(header.querySelector('.lucide-activity')).toBeInTheDocument()
    // Two kind icons and the chevron: the aggregate state dot is gone.
    expect(header.querySelectorAll('svg')).toHaveLength(3)
    for (const icon of header.querySelectorAll('svg')) {
      expect(icon).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('gives the monitor heartbeat the sidebar amber and leaves other kinds neutral', () => {
    const header = renderHeader([
      { id: 'a1', kind: 'agent' },
      { id: 'm1', kind: 'monitor' }
    ])
    // Same glyph AND same colour as AgentStateDot/StatusIndicator, or a monitor
    // here does not read as the monitor there.
    expect(header.querySelector('.lucide-activity')?.classList).toContain('text-yellow-500')
    expect(header.querySelector('.lucide-bot')?.classList).toContain('text-muted-foreground')
    expect(header.querySelector('.lucide-bot')?.classList).not.toContain('text-yellow-500')
  })

  it('dims the monitor amber while a turn owns the voice', () => {
    render(
      <NativeChatBackgroundTasksStatus
        isVisible
        tasks={[{ id: 'm1', kind: 'monitor' }]}
        settledTasks={[]}
        indicatorActive={false}
        supportsTaskStop={false}
        supportsStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={() => {}}
      />
    )
    const header = screen.getByRole('button', { expanded: false })
    expect(header.querySelector('.lucide-activity')?.classList).toContain('text-yellow-500/40')
  })

  it('carries the monitor amber on the expanded row too', () => {
    const header = renderHeader([
      { id: 'm1', kind: 'monitor', description: 'watcher' },
      { id: 'c1', kind: 'command', description: 'sleep 90' }
    ])
    fireEvent.click(header)
    // Each kind group is its own labelled list, so scope to the monitor one.
    const monitors = screen.getByRole('list', { name: 'Monitors' })
    expect(monitors.querySelector('.lucide-activity')?.classList).toContain('text-yellow-500')
    const shell = screen.getByRole('list', { name: 'Shell' })
    expect(shell.querySelector('.lucide-square-terminal')?.classList).toContain(
      'text-muted-foreground'
    )
  })

  it('draws the segment separator in a visible text tone, not the divider token', () => {
    const header = renderHeader([
      { id: 'a1', kind: 'agent' },
      { id: 'c1', kind: 'command' }
    ])
    const separators = [...header.querySelectorAll('span')].filter(
      (element) => element.textContent === ' · '
    )
    expect(separators).toHaveLength(1)
    // `--border` is a divider line (7% white in dark), an order of magnitude
    // fainter than the counts it sits between.
    expect(separators[0].classList).not.toContain('text-border')
    expect(separators[0].classList).toContain('text-muted-foreground')
    // One space either side; the icon's own margin is the icon-to-label gap.
    expect(header.textContent).toBe('1 agent · 1 shell')
  })

  it('carries no icon on a collapsed total, which spans kinds', () => {
    const header = renderHeader([
      { id: 'a1', kind: 'agent' },
      { id: 'c1', kind: 'command' },
      { id: 'm1', kind: 'monitor' },
      { id: 'w1', kind: 'workflow' }
    ])
    expect(header).toHaveAttribute('aria-label', '4 background tasks')
    expect(header.querySelectorAll('svg')).toHaveLength(1)
  })
})

describe('settled rows beside their live siblings', () => {
  // Retention is the PR's headline: a finished child stays visible, keeps the
  // usage it ended on, and stops claiming a clock or a stop control.
  it('keeps a settled row with its final usage, no clock and no stop', () => {
    render(
      <NativeChatBackgroundTasksStatus
        isVisible
        tasks={[
          {
            id: 'agent-live',
            kind: 'agent',
            description: 'live child',
            startedAt: 1_000,
            totalTokens: 4_100
          }
        ]}
        settledTasks={[
          {
            id: 'agent-settled',
            kind: 'agent',
            description: 'settled child',
            state: 'done',
            startedAt: 500,
            totalTokens: 18_130
          }
        ]}
        indicatorActive
        supportsTaskStop
        supportsStopAll
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const agents = screen.getByRole('list', { name: 'Agents' })
    const rows = within(agents).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    // First seen first: the settled sibling started earlier.
    expect(rows[0].textContent).toBe('settled child18.1k')
    expect(rows[1].textContent).toMatch(/^live child4\.1k · .+Stop$/)
    expect(within(rows[1]).getByRole('button', { name: 'Stop live child' })).toBeInTheDocument()
    expect(within(rows[0]).queryByRole('button')).toBeNull()
  })
})

describe('background-task row reasons', () => {
  function expandedRows(tasks: AgentSessionBackgroundTask[]): HTMLElement[] {
    render(
      <NativeChatBackgroundTasksStatus
        isVisible
        tasks={tasks}
        settledTasks={[]}
        indicatorActive
        supportsTaskStop={false}
        supportsStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    return screen.getAllByRole('listitem')
  }

  // `unverifiable` is the SSH verdict for "no contact"; a row that hides it reads
  // like a working child. `blocked` is the same class of loss.
  it('names the reason on every attention state, not only on waiting', () => {
    const rows = expandedRows([
      { id: 'a1', kind: 'agent', description: 'ssh child', state: 'unverifiable' },
      { id: 'a2', kind: 'agent', description: 'flaky child', state: 'blocked' },
      { id: 'a3', kind: 'agent', description: 'approval child', state: 'waiting' },
      { id: 'a4', kind: 'agent', description: 'busy child', state: 'working' }
    ])
    expect(rows).toHaveLength(4)
    expect(rows[0].textContent).toContain('ssh child · no contact')
    expect(rows[1].textContent).toContain('flaky child · failed')
    expect(rows[2].textContent).toContain('approval child · needs approval')
    // A running row has nothing to explain.
    expect(rows[3].textContent).not.toContain('·')
  })
})

it('stops elapsed renders in a hidden pane and catches up on reveal', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const committed = vi.fn()
  const view = (isVisible: boolean) => (
    <Profiler id="strip" onRender={committed}>
      <NativeChatBackgroundTasksStatus
        isVisible={isVisible}
        tasks={[{ id: 'shell', kind: 'command', startedAt: 1_000 }]}
        settledTasks={[]}
        indicatorActive
        supportsTaskStop={false}
        supportsStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={() => {}}
      />
    </Profiler>
  )
  const { rerender, unmount } = render(view(true))
  committed.mockClear()
  act(() => vi.advanceTimersByTime(1_000))
  expect(committed).toHaveBeenCalled()
  rerender(view(false))
  committed.mockClear()
  act(() => vi.advanceTimersByTime(10_000))
  expect(committed).not.toHaveBeenCalled()
  rerender(view(true))
  committed.mockClear()
  act(() => vi.advanceTimersByTime(1_000))
  expect(committed).toHaveBeenCalled()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
