// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import type { DashboardLaneAction } from '../../../../shared/dashboard-lanes'
import { i18n } from '@/i18n/i18n'
import { AgentKanbanBoard } from './AgentKanbanBoard'
import { AGENT_CARD_DRAG_TYPE } from './AgentKanbanColumn'

vi.mock('./AgentKanbanCard', () => ({
  AgentKanbanCard: ({ card }: { card: DashboardCard }) => (
    <div data-testid="card">{card.worktreeName}</div>
  )
}))
vi.mock('./AgentTerminalDialog', () => ({ AgentTerminalDialog: () => null }))

function card(overrides: Partial<DashboardCard>): DashboardCard {
  return {
    paneKey: 'tab:1',
    ptyId: 'p1',
    agentType: 'claude',
    bucket: 'done',
    dotState: 'done',
    task: 't',
    repoId: 'r1',
    worktreeId: 'w1',
    tabId: 'tab',
    leafId: 'l1',
    repoName: 'Repo',
    worktreeName: 'wt',
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: true,
    ...overrides
  }
}

const waiting = { id: 'lane-w', label: 'Waiting' }

function snapshotOf(cards: DashboardCard[], extra: Partial<DashboardSnapshot> = {}) {
  return { generatedAt: 1, cards, customLanes: [waiting], ...extra }
}

/** happy-dom has no DataTransfer; fireEvent copies these members onto the event. */
function dataTransfer() {
  const data = new Map<string, string>()
  return {
    types: [AGENT_CARD_DRAG_TYPE],
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    dropEffect: 'none',
    effectAllowed: 'all'
  }
}

function drag(cardName: string, toRegion: string): void {
  const source = screen.getByText(cardName).parentElement
  if (!source) {
    throw new Error(`no drag handle for ${cardName}`)
  }
  const target = screen.getByRole('region', { name: toRegion })
  const transfer = dataTransfer()
  fireEvent.dragStart(source, { dataTransfer: transfer })
  fireEvent.dragOver(target, { dataTransfer: transfer })
  fireEvent.drop(target, { dataTransfer: transfer })
  fireEvent.dragEnd(source, { dataTransfer: transfer })
}

describe('AgentKanbanBoard custom lanes', () => {
  const onLaneAction = vi.fn<(action: DashboardLaneAction) => void>()

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    )
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders custom lanes after the status columns with parked cards inside', () => {
    render(
      <AgentKanbanBoard
        snapshot={snapshotOf([card({ laneId: 'lane-w', worktreeName: 'parked' })])}
        onLaneAction={onLaneAction}
      />
    )
    expect(
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))
    ).toEqual(['Needs You', 'Working', 'Done', 'Waiting'])
    expect(
      within(screen.getByRole('region', { name: 'Waiting' })).getByText('parked')
    ).toBeInTheDocument()
  })

  it('keeps a parked card visible even when its status column (idle) is hidden', () => {
    render(
      <AgentKanbanBoard
        snapshot={snapshotOf([
          card({ bucket: 'idle', laneId: 'lane-w', worktreeName: 'quiet' }),
          card({ paneKey: 'tab:2', bucket: 'idle', worktreeName: 'hidden' })
        ])}
        onLaneAction={onLaneAction}
      />
    )
    expect(screen.getByText('quiet')).toBeInTheDocument()
    expect(screen.queryByText('hidden')).not.toBeInTheDocument()
  })

  it('parks a dragged card and shows it in the lane before the snapshot catches up', () => {
    render(
      <AgentKanbanBoard
        snapshot={snapshotOf([card({ worktreeName: 'finished' })])}
        onLaneAction={onLaneAction}
      />
    )
    drag('finished', 'Waiting')

    expect(onLaneAction).toHaveBeenCalledWith({
      kind: 'place',
      paneKey: 'tab:1',
      laneId: 'lane-w'
    })
    expect(
      within(screen.getByRole('region', { name: 'Waiting' })).getByText('finished')
    ).toBeInTheDocument()
  })

  it('unparks a card dropped back on a status column', () => {
    render(
      <AgentKanbanBoard
        snapshot={snapshotOf([card({ laneId: 'lane-w', worktreeName: 'parked' })])}
        onLaneAction={onLaneAction}
      />
    )
    drag('parked', 'Working')

    expect(onLaneAction).toHaveBeenCalledWith({ kind: 'place', paneKey: 'tab:1', laneId: null })
    expect(
      within(screen.getByRole('region', { name: 'Done' })).getByText('parked')
    ).toBeInTheDocument()
  })

  it('ignores drops of an unparked card on another status column', () => {
    render(
      <AgentKanbanBoard
        snapshot={snapshotOf([card({ worktreeName: 'finished' })])}
        onLaneAction={onLaneAction}
      />
    )
    drag('finished', 'Working')
    expect(onLaneAction).not.toHaveBeenCalled()
  })

  it('does not let a card that needs you be dragged away', () => {
    render(
      <AgentKanbanBoard
        snapshot={snapshotOf([
          card({ bucket: 'attention', dotState: 'waiting', worktreeName: 'asking' })
        ])}
        onLaneAction={onLaneAction}
      />
    )
    expect(screen.getByText('asking').parentElement).toHaveAttribute('draggable', 'false')
  })

  it('adds, renames and removes lanes', () => {
    render(<AgentKanbanBoard snapshot={snapshotOf([])} onLaneAction={onLaneAction} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add lane' }))
    const input = screen.getByRole('textbox', { name: 'New lane name' })
    fireEvent.change(input, { target: { value: 'Blocked on CI' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onLaneAction).toHaveBeenCalledWith({ kind: 'add', label: 'Blocked on CI' })

    fireEvent.doubleClick(screen.getByText('Waiting'))
    const rename = screen.getByRole('textbox', { name: 'Lane name' })
    fireEvent.change(rename, { target: { value: 'Parked' } })
    fireEvent.keyDown(rename, { key: 'Enter' })
    expect(onLaneAction).toHaveBeenCalledWith({ kind: 'rename', laneId: 'lane-w', label: 'Parked' })

    fireEvent.click(screen.getByRole('button', { name: 'Remove lane Waiting' }))
    expect(onLaneAction).toHaveBeenCalledWith({ kind: 'remove', laneId: 'lane-w' })
  })

  it('cancels adding a lane on Escape', () => {
    render(<AgentKanbanBoard snapshot={snapshotOf([])} onLaneAction={onLaneAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add lane' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'New lane name' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'New lane name' })).not.toBeInTheDocument()
    expect(onLaneAction).not.toHaveBeenCalled()
  })
})
