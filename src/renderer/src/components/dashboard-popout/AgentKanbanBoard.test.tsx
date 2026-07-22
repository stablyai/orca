// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { AgentKanbanBoard } from './AgentKanbanBoard'

// Stub the card and dialog so the board test stays free of xterm / Radix
// machinery while still exercising the board-owned dialog wiring.
vi.mock('./AgentKanbanCard', () => ({
  AgentKanbanCard: ({
    card,
    onOpenTerminal
  }: {
    card: DashboardCard
    onOpenTerminal: (card: DashboardCard) => void
  }) => (
    <div
      data-testid="card"
      data-bucket={card.bucket}
      data-unseen={card.unseen}
      onClick={() => onOpenTerminal(card)}
    >
      {card.worktreeName}
    </div>
  )
}))
vi.mock('./AgentTerminalDialog', () => ({
  AgentTerminalDialog: ({
    card,
    onOpenChange
  }: {
    card: DashboardCard | null
    onOpenChange: (open: boolean) => void
  }) => (
    <div
      data-testid="terminal-dialog"
      data-open={card !== null}
      data-bucket={card?.bucket}
      data-pty-id={card?.ptyId ?? undefined}
    >
      <button data-testid="terminal-dialog-close" onClick={() => onOpenChange(false)} />
    </div>
  )
}))

function card(overrides: Partial<DashboardCard>): DashboardCard {
  return {
    paneKey: Math.random().toString(36),
    ptyId: 'p1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 't',
    repoId: 'r1',
    worktreeId: 'w1',
    tabId: 'tab1',
    leafId: 'l1',
    repoName: 'Repo',
    worktreeName: 'wt',
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: false,
    ...overrides
  }
}

function renderBoard(cards: DashboardCard[]): void {
  const snapshot: DashboardSnapshot = { generatedAt: 1, cards }
  render(<AgentKanbanBoard snapshot={snapshot} />)
}

const ackAgent = vi.fn(async () => {})

describe('AgentKanbanBoard', () => {
  beforeEach(() => {
    // The board relays seen-acks through the dashboard preload API.
    ;(window as unknown as { api: unknown }).api = { dashboard: { ackAgent } }
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders the three fixed columns in order', () => {
    renderBoard([])
    const headers = screen.getAllByText(/Needs You|Working|Idle/)
    expect(headers.map((h) => h.textContent)).toEqual(['Needs You', 'Working', 'Idle'])
  })

  it('places cards in their bucket column and counts them', () => {
    renderBoard([
      card({ bucket: 'attention', worktreeName: 'a1' }),
      card({ bucket: 'attention', worktreeName: 'a2' }),
      card({ bucket: 'idle', worktreeName: 'i1' })
    ])
    const cards = screen.getAllByTestId('card')
    expect(cards).toHaveLength(3)
    expect(cards.filter((c) => c.dataset.bucket === 'attention')).toHaveLength(2)
    expect(within(document.body).getByText('i1').dataset.bucket).toBe('idle')
    expect(screen.getByText('3 total')).toBeTruthy()
  })

  it('shows "None" for empty columns', () => {
    renderBoard([card({ bucket: 'working' })])
    // attention and idle are empty → two "None" placeholders.
    expect(screen.getAllByText('None')).toHaveLength(2)
  })

  it('orders cards in a column by most recent bucket entry first', () => {
    renderBoard([
      card({ bucket: 'working', worktreeName: 'old-move', stateChangedAt: 1000 }),
      card({ bucket: 'working', worktreeName: 'new-move', stateChangedAt: 3000 }),
      card({ bucket: 'working', worktreeName: 'mid-move', stateChangedAt: 2000 })
    ])
    const names = screen.getAllByTestId('card').map((c) => c.textContent)
    expect(names).toEqual(['new-move', 'mid-move', 'old-move'])
  })

  it('keeps the terminal dialog open across bucket moves and card removal', () => {
    const agent = card({ paneKey: 'pk-1', bucket: 'idle', worktreeName: 'wt1' })
    const { rerender } = render(<AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [agent] }} />)
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('false')

    fireEvent.click(screen.getByTestId('card'))
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('true')

    // Sending a message flips the agent idle → working; the dialog must
    // follow the card to its new bucket instead of closing.
    const moved = { ...agent, bucket: 'working' as const, dotState: 'working' as const }
    rerender(<AgentKanbanBoard snapshot={{ generatedAt: 2, cards: [moved] }} />)
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('true')
    expect(screen.getByTestId('terminal-dialog').dataset.bucket).toBe('working')

    // Even a vanished card (pane closed) keeps the dialog up — the user
    // dismisses it explicitly, but stale live routing is cleared.
    rerender(<AgentKanbanBoard snapshot={{ generatedAt: 3, cards: [] }} />)
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('true')
    expect(screen.getByTestId('terminal-dialog').dataset.ptyId).toBeUndefined()
  })

  it('relays a seen-ack when a dialog opens and when the open agent changes state', () => {
    const agent = card({ paneKey: 'pk-ack', bucket: 'idle', unseen: true })
    const { rerender } = render(<AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [agent] }} />)
    // unseen comes straight from the snapshot (the shared ack map).
    expect(screen.getByTestId('card').dataset.unseen).toBe('true')

    fireEvent.click(screen.getByTestId('card'))
    expect(ackAgent).toHaveBeenCalledWith('pk-ack')
    ackAgent.mockClear()

    // The ack round-trips through the main window; the next snapshot mutes it.
    rerender(
      <AgentKanbanBoard snapshot={{ generatedAt: 2, cards: [{ ...agent, unseen: false }] }} />
    )
    expect(screen.getByTestId('card').dataset.unseen).toBe('false')
    expect(ackAgent).not.toHaveBeenCalled()

    // A state change while the dialog is open re-acks (watching counts as
    // seeing), so the card never flips bold under an open dialog.
    rerender(
      <AgentKanbanBoard
        snapshot={{
          generatedAt: 3,
          cards: [{ ...agent, bucket: 'working' as const, stateChangedAt: 2000, unseen: true }]
        }}
      />
    )
    expect(ackAgent).toHaveBeenCalledWith('pk-ack')
  })
})
