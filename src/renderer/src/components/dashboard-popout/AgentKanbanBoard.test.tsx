// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  DashboardCard,
  DashboardFilterOptions,
  DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { i18n } from '@/i18n/i18n'
import { AgentKanbanBoard } from './AgentKanbanBoard'

// Stub card/dialog internals while retaining the board’s dialog wiring.
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
    onOpenTerminal: (card: DashboardCard, event: MouseEvent) => void
  }) => (
    <div
      data-testid="card"
      data-bucket={card.bucket}
      data-unseen={card.unseen}
      data-now={now}
      data-repo-icon={repoIcon === null ? 'none' : JSON.stringify(repoIcon)}
      onClick={(event) => onOpenTerminal(card, event.nativeEvent)}
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
    ;(window as unknown as { api: unknown }).api = { dashboard: { ackAgent } }
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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

    // Replying moves done agents to working; the dialog must survive the bucket change.
    const moved = { ...agent, bucket: 'working' as const, dotState: 'working' as const }
    rerender(<AgentKanbanBoard snapshot={{ generatedAt: 2, cards: [moved] }} />)
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('true')
    expect(screen.getByTestId('terminal-dialog').dataset.bucket).toBe('working')

    // Keep vanished-card dialogs open until dismissed, but clear stale live routing.
    rerender(<AgentKanbanBoard snapshot={{ generatedAt: 3, cards: [] }} />)
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('true')
    expect(screen.getByTestId('terminal-dialog').dataset.ptyId).toBeUndefined()
  })

  it('reveals the worktree directly on Mod+click and skips the preview dialog (#36250)', () => {
    const revealAgent = vi.fn()
    const agent = card({
      paneKey: 'pk-mod',
      bucket: 'done',
      unseen: true,
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    render(
      <AgentKanbanBoard snapshot={{ generatedAt: 1, cards: [agent] }} onRevealAgent={revealAgent} />
    )
    const mac = navigator.userAgent.includes('Mac')

    fireEvent.click(screen.getByTestId('card'), { metaKey: mac, ctrlKey: !mac })
    expect(revealAgent).toHaveBeenCalledWith({
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      executionHostId: agent.executionHostId,
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    expect(ackAgent.mock.calls).toEqual([['pk-mod', 'explicit']])
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('false')

    // Plain click keeps the preview flow.
    fireEvent.click(screen.getByTestId('card'))
    expect(revealAgent).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('terminal-dialog').dataset.open).toBe('true')
  })
})
