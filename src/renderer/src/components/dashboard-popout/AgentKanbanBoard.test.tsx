// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {
  DashboardCard,
  DashboardFilterOptions,
  DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { i18n } from '@/i18n/i18n'
import { AgentKanbanBoard } from './AgentKanbanBoard'

// Stub the card and dialog so the board test stays free of xterm / Radix
// machinery while still exercising the board-owned dialog wiring.
vi.mock('./AgentKanbanCard', () => ({
  AgentKanbanCard: ({
    card,
    repoIcon,
    now,
    onOpenTerminal
  }: {
    card: DashboardCard
    repoIcon?: RepoIcon | null
    now: number
    onOpenTerminal: (card: DashboardCard) => void
  }) => (
    <div
      data-testid="card"
      data-bucket={card.bucket}
      data-unseen={card.unseen}
      data-now={now}
      data-repo-icon={repoIcon === null ? 'none' : JSON.stringify(repoIcon)}
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

function renderBoard(
  cards: DashboardCard[],
  options: {
    showIdle?: boolean
    repoIconsByRepoId?: Record<string, RepoIcon | null>
    filterOptions?: DashboardFilterOptions
  } = {}
): void {
  const snapshot: DashboardSnapshot = { generatedAt: 1, cards, ...options }
  render(<AgentKanbanBoard snapshot={snapshot} />)
}

const ackAgent = vi.fn(async () => {})

describe('AgentKanbanBoard', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    localStorage.clear()
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    )
    // The board relays seen-acks through the dashboard preload API.
    ;(window as unknown as { api: unknown }).api = { dashboard: { ackAgent } }
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the three default columns in order', () => {
    renderBoard([])
    const headers = screen.getAllByText(/Needs You|Working|Done/)
    expect(headers.map((h) => h.textContent)).toEqual(['Needs You', 'Working', 'Done'])
  })

  it('hides the agent map from dashboard chrome', () => {
    renderBoard([])

    expect(screen.queryByRole('button', { name: 'Agent Map' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dashboard' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Dashboard view' })).not.toBeInTheDocument()
    expect(screen.getByText('Needs You')).toBeInTheDocument()
  })

  it('offers project filters without agent-state map filters', async () => {
    renderBoard([card({ paneKey: 'busy' })])

    fireEvent.pointerDown(screen.getByRole('button', { name: /^Filter/ }))
    expect(await screen.findByText('Project')).toBeInTheDocument()
    expect(screen.queryByText('Agent states')).not.toBeInTheDocument()
  })

  it('focuses search with Ctrl+K without taking focus from response fields', () => {
    renderBoard([])
    const search = screen.getByLabelText('Search agents')

    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    expect(search).toHaveFocus()

    const response = document.createElement('textarea')
    document.body.append(response)
    response.focus()
    fireEvent.keyDown(response, { key: 'k', ctrlKey: true })
    expect(response).toHaveFocus()
    response.remove()
  })

  it('places cards in their bucket column and counts them', () => {
    renderBoard([
      card({ bucket: 'attention', worktreeName: 'a1' }),
      card({ bucket: 'attention', worktreeName: 'a2' }),
      card({ bucket: 'done', worktreeName: 'd1' })
    ])
    const cards = screen.getAllByTestId('card')
    expect(cards).toHaveLength(3)
    expect(cards.filter((c) => c.dataset.bucket === 'attention')).toHaveLength(2)
    expect(within(document.body).getByText('d1').dataset.bucket).toBe('done')
    expect(screen.getByText('3 total')).toBeTruthy()
  })

  it('leaves every column border neutral now that cards carry the state color', () => {
    renderBoard([card({ bucket: 'attention' })])
    for (const column of document.querySelectorAll('section')) {
      expect(column.className).toContain('border-border/60')
      expect(column.className).not.toContain('amber')
    }
  })

  it('routes each card its own repo icon', () => {
    renderBoard(
      [
        card({ repoId: 'r1', worktreeName: 'from-r1' }),
        card({ repoId: 'r2', worktreeName: 'from-r2' }),
        card({ repoId: 'r3', worktreeName: 'from-r3' })
      ],
      { repoIconsByRepoId: { r1: { type: 'lucide', name: 'Rocket' }, r2: null } }
    )

    expect(screen.getByText('from-r1').dataset.repoIcon).toBe('{"type":"lucide","name":"Rocket"}')
    expect(screen.getByText('from-r2').dataset.repoIcon).toBe('none')
    // Unknown repo → the card's own default glyph, never another repo's icon.
    expect(screen.getByText('from-r3').dataset.repoIcon).toBe('none')
  })

  it('shows "None" for empty columns', () => {
    renderBoard([card({ bucket: 'working' })])
    // attention and done are empty → two "None" placeholders.
    expect(screen.getAllByText('None')).toHaveLength(2)
  })

  it('shows the idle column only when enabled', () => {
    renderBoard([card({ bucket: 'idle', worktreeName: 'quiet-agent' })], { showIdle: true })

    expect(screen.getByText('Idle')).toBeInTheDocument()
    expect(screen.getByText('quiet-agent')).toBeInTheDocument()
  })

  it('searches agent content and reports the visible result count', () => {
    renderBoard([
      card({ worktreeName: 'first', task: 'repair relay authentication' }),
      card({ worktreeName: 'second', task: 'update dashboard layout' })
    ])

    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'relay' } })

    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.queryByText('second')).not.toBeInTheDocument()
    expect(screen.getByText('1 of 2 shown')).toBeInTheDocument()
  })

  it('localizes the new board status and filter controls', async () => {
    await i18n.changeLanguage('ja')
    renderBoard([card({ bucket: 'done' })])

    expect(screen.getByText('完了')).toBeInTheDocument()
    expect(screen.getByLabelText('Agent を検索')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^フィルター/ })).toBeInTheDocument()
  })

  it('offers store-derived project and status filters without cards', async () => {
    renderBoard([], {
      filterOptions: {
        projects: [{ id: 'r1', label: 'Repo One' }],
        workspaceStatuses: [{ id: 'planned', label: 'Planned', color: 'neutral' }]
      }
    })

    fireEvent.pointerDown(screen.getByRole('button', { name: /^Filter/ }))

    expect(await screen.findByText('Repo One')).toBeInTheDocument()
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('PR / MR status')).toBeInTheDocument()
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

  it('does not start the clock when no card renders a relative timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)

    const { rerender } = render(<AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [] }} />)
    expect(vi.getTimerCount()).toBe(0)

    rerender(
      <AgentKanbanBoard
        snapshot={{ generatedAt: 2, cards: [card({ startedAt: 0, finishedAt: null })] }}
      />
    )
    const initialNow = screen.getByTestId('card').dataset.now

    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByTestId('card').dataset.now).toBe(initialNow)
  })

  it('parks the clock while hidden, catches up on reveal, and ticks while visible', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    let visibilityState: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)

    renderBoard([card({ startedAt: 1 })])
    expect(screen.getByTestId('card').dataset.now).toBe('100000')
    expect(vi.getTimerCount()).toBe(0)

    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByTestId('card').dataset.now).toBe('100000')

    visibilityState = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(screen.getByTestId('card').dataset.now).toBe('160000')
    expect(vi.getTimerCount()).toBe(1)

    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByTestId('card').dataset.now).toBe('190000')
  })

  it('keeps the terminal dialog open across bucket moves and card removal', () => {
    const agent = card({ paneKey: 'pk-1', bucket: 'done', worktreeName: 'wt1' })
    const { rerender } = render(
      <AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [agent], showIdle: true }} />
    )
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('false')

    fireEvent.click(screen.getByTestId('card'))
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('true')

    // Sending a message flips the agent done → working; the dialog must
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
    const agent = card({ paneKey: 'pk-ack', bucket: 'done', unseen: true })
    const { rerender } = render(<AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [agent] }} />)
    // unseen comes straight from the snapshot (the shared ack map).
    expect(screen.getByTestId('card').dataset.unseen).toBe('true')

    fireEvent.click(screen.getByTestId('card'))
    expect(ackAgent).toHaveBeenCalledWith('pk-ack')
    ackAgent.mockClear()

    // The ack round-trips through the main window; the next snapshot mutes it.
    rerender(
      <AgentKanbanBoard
        snapshot={{
          generatedAt: 2,
          cards: [{ ...agent, bucket: 'idle', unseen: false }],
          showIdle: true
        }}
      />
    )
    expect(screen.getByTestId('card').dataset.unseen).toBe('false')
    expect(screen.getByTestId('card').dataset.bucket).toBe('idle')
    expect(ackAgent).not.toHaveBeenCalled()

    // A state change while the dialog is open re-acks (watching counts as
    // seeing), so the card never flips bold under an open dialog.
    rerender(
      <AgentKanbanBoard
        snapshot={{
          generatedAt: 3,
          cards: [{ ...agent, bucket: 'working' as const, stateChangedAt: 2000, unseen: true }],
          showIdle: true
        }}
      />
    )
    expect(ackAgent).toHaveBeenCalledWith('pk-ack')
  })
})
