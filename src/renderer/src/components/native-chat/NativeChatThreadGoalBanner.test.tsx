// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentJournalThreadGoal } from '../../../../shared/agent-session-journal-types'
import { NativeChatThreadGoalBanner } from './NativeChatThreadGoalBanner'
import { formatNativeChatThreadGoalElapsed } from './native-chat-thread-goal-presentation'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NOW = 10_000_000

function goal(overrides: Partial<AgentJournalThreadGoal> = {}): AgentJournalThreadGoal {
  return {
    objective: 'Ship the parser',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 60,
    createdAt: NOW,
    updatedAt: NOW - 7_000,
    ...overrides
  }
}

function renderBanner(
  value: AgentJournalThreadGoal,
  pending = false,
  runningTurn: { startedAt: number | null } | null = { startedAt: null }
) {
  const onChange = vi.fn()
  const view = render(
    <TooltipProvider>
      <NativeChatThreadGoalBanner
        goal={value}
        pending={pending}
        isVisible
        runningTurn={runningTurn}
        onChange={onChange}
      />
    </TooltipProvider>
  )
  return { onChange, view }
}

describe('NativeChatThreadGoalBanner', () => {
  it('shows an active goal with its running time and pause control', () => {
    vi.useFakeTimers({ now: NOW })
    const { onChange } = renderBanner(goal())

    expect(screen.getByText('Pursuing goal')).toBeInTheDocument()
    expect(screen.getByText('Ship the parser')).toBeInTheDocument()
    expect(screen.getByText('• 1m 7s')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Pause goal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }))
    expect(onChange.mock.calls).toEqual([
      [{ kind: 'status', status: 'paused' }],
      [{ kind: 'clear' }]
    ])
    expect(screen.queryByRole('button', { name: 'Resume goal' })).toBeNull()
  })

  it('shows the reported time for an active goal while no turn runs', () => {
    vi.useFakeTimers({ now: NOW })
    renderBanner(goal(), false, null)
    expect(screen.getByText('• 1m 0s')).toBeInTheDocument()
  })

  it('offers resume on a paused goal and does not count time since the report', () => {
    vi.useFakeTimers({ now: NOW })
    const { onChange } = renderBanner(goal({ status: 'paused' }))

    expect(screen.getByText('Paused goal')).toBeInTheDocument()
    expect(screen.getByText('• 1m 0s')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Resume goal' }))
    expect(onChange).toHaveBeenCalledWith({ kind: 'status', status: 'active' })
  })

  it.each([
    ['blocked', 'Goal blocked'],
    ['usageLimited', 'Goal limited']
  ] as const)(
    'offers resume on a %s goal, which the provider resumes like a paused one',
    (status, label) => {
      const { onChange } = renderBanner(goal({ status }))
      expect(screen.getByText(label)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Pause goal' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Resume goal' }))
      expect(onChange).toHaveBeenCalledWith({ kind: 'status', status: 'active' })
    }
  )

  it('labels a goal whose token budget is spent and offers only clear', () => {
    renderBanner(goal({ status: 'budgetLimited' }))
    expect(screen.getByText('Goal limited')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear goal' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Pause goal' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resume goal' })).toBeNull()
  })

  it('renders nothing for a completed goal', () => {
    const { view } = renderBanner(goal({ status: 'complete' }))
    expect(view.container).toBeEmptyDOMElement()
  })

  it('disables the goal commands while one is in flight, but not the expand toggle', () => {
    renderBanner(goal(), true)
    expect(screen.getByRole('button', { name: 'Clear goal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pause goal' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Show full goal' }))
    expect(screen.getByRole('button', { name: 'Hide full goal' })).toBeEnabled()
  })
})

describe('formatNativeChatThreadGoalElapsed', () => {
  it.each([
    [25, '25s'],
    [67, '1m 7s'],
    [7_380, '2h 3m'],
    [-4, '0s']
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatNativeChatThreadGoalElapsed(seconds)).toBe(expected)
  })
})
