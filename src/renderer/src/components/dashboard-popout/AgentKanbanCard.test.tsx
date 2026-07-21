// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { i18n } from '@/i18n/i18n'
import { AgentKanbanCard } from './AgentKanbanCard'

const agentIconRender = vi.fn()

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => {
    agentIconRender()
    return <span data-testid="agent-icon" />
  }
}))

vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: () => <span data-testid="state-dot" />
}))

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'tab:leaf',
    ptyId: 'pty-1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'Review the change',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab',
    leafId: 'leaf',
    repoName: 'Orca',
    worktreeName: 'dashboard-review',
    startedAt: 1_000,
    stateChangedAt: 1_000,
    unseen: false,
    ...overrides
  }
}

describe('AgentKanbanCard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('does not render an invented age when the start time is unknown', () => {
    render(
      <AgentKanbanCard card={card({ startedAt: 0 })} now={2_000_000_000} onOpenTerminal={vi.fn()} />
    )

    expect(screen.queryByText(/\d+d/)).not.toBeInTheDocument()
  })

  it('skips structured-clone rerenders until visible card data or its age changes', () => {
    const onOpenTerminal = vi.fn()
    const initial = card({ startedAt: 1_000 })
    const { rerender } = render(
      <AgentKanbanCard card={initial} now={61_500} onOpenTerminal={onOpenTerminal} />
    )
    expect(agentIconRender).toHaveBeenCalledTimes(1)
    expect(screen.getByText('1m')).toBeInTheDocument()

    rerender(<AgentKanbanCard card={{ ...initial }} now={62_000} onOpenTerminal={onOpenTerminal} />)
    expect(agentIconRender).toHaveBeenCalledTimes(1)

    rerender(
      <AgentKanbanCard card={{ ...initial }} now={121_500} onOpenTerminal={onOpenTerminal} />
    )
    expect(agentIconRender).toHaveBeenCalledTimes(2)
    expect(screen.getByText('2m')).toBeInTheDocument()
  })

  it('updates the relative age when the UI language changes', async () => {
    render(
      <AgentKanbanCard card={card({ startedAt: 1_000 })} now={121_500} onOpenTerminal={vi.fn()} />
    )
    expect(screen.getByText('2m')).toBeInTheDocument()

    await act(async () => {
      await i18n.changeLanguage('ja')
    })

    expect(screen.getByText('2分')).toBeInTheDocument()
  })
})
