// @vitest-environment happy-dom

/**
 * The two new axes as the user meets them: a state chip has to reflow the grid, not
 * just shorten the list, and hiding a card has to take it out without disturbing the
 * cards around it. The three hide entry points share one store field, so this also
 * pins that the card header and the tab bar's menu never disagree about a tab.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactVirtual from '@tanstack/react-virtual'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useAppStore } from '@/store'
import SessionsGridPage from './SessionsGridPage'
import { SortableTabContextMenu } from '../tab-bar/SortableTabContextMenu'
import { livePtyIdsFor } from './session-grid-test-live-ptys'
import { resetTerminalTabActivityFlagsCacheForTest } from '@/components/tab-bar/terminal-tab-activity-status'
import { sessionGridVisibilityActionLabel } from './session-grid-visibility-labels'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

vi.mock('@tanstack/react-virtual', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactVirtual>()),
  useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * options.estimateSize(index),
        size: options.estimateSize(index)
      })),
    getTotalSize: () => options.count * options.estimateSize(0),
    measure: () => {}
  })
}))
vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({ ptyId }: { ptyId: string }) => (
    <div data-testid="mock-terminal-preview" data-pty-id={ptyId} />
  )
}))

const LEAVES = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'
]

function entry(paneKey: string, state: 'blocked' | 'working' | 'done'): AgentStatusEntry {
  const updatedAt = Date.now()
  return {
    paneKey,
    state,
    agentType: 'claude',
    prompt: '',
    updatedAt,
    stateStartedAt: updatedAt
  } as unknown as AgentStatusEntry
}

/** `count` cards in one workspace, each on its own leaf, with an optional per-card status. */
function seedCards(count: number, statuses: Record<number, 'blocked' | 'working' | 'done'> = {}) {
  const tabs = Array.from({ length: count }, (_, i) => ({
    id: `tab-${i}`,
    ptyId: `pty-${i}`,
    worktreeId: 'wt-1',
    title: `Session ${i}`,
    createdAt: i
  })) as TerminalTab[]
  const tabsByWorktree = { 'wt-1': tabs }
  useAppStore.setState({
    activeView: 'sessions',
    repos: [{ id: 'repo-1', displayName: 'sytio', path: '/code/sytio' } as unknown as Repo],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', displayName: 'sytio', branch: 'main' } as unknown as Worktree]
    },
    folderWorkspaces: [],
    projectGroups: [],
    tabsByWorktree,
    ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab, i) => [
        tab.id,
        { activeLeafId: LEAVES[i], ptyIdsByLeafId: { [LEAVES[i]!]: `pty-${i}` } }
      ])
    ) as never,
    agentStatusByPaneKey: Object.fromEntries(
      Object.entries(statuses).map(([index, state]) => {
        const paneKey = `tab-${index}:${LEAVES[Number(index)]}`
        return [paneKey, entry(paneKey, state)]
      })
    ),
    agentStatusEpoch: 1,
    sessionsGridPreset: 'auto',
    sessionsGridZoom: 1,
    sessionsGridShowEmpty: true,
    sessionsGridScrollMode: 'row',
    sessionsGridFilter: 'all',
    sessionsGridStateFilter: 'all',
    sessionsGridTabOrder: [],
    sessionsGridHiddenTabIds: [],
    activeSessionGridTabId: null
  })
  return tabs
}

function renderedTabIds(): string[] {
  return screen
    .queryAllByTestId('session-grid-card')
    .map((card) => card.getAttribute('data-tab-id') ?? '')
}

/** The column count the `auto` preset resolved to, read off the row's own grid template. */
function gridColumns(): number {
  const row = document.querySelector<HTMLElement>('[style*="grid-template-columns"]')!
  return Number(/repeat\((\d+)/.exec(row.style.gridTemplateColumns)![1])
}

function hideButtonOf(tabId: string): HTMLElement {
  return document.querySelector<HTMLElement>(
    `[data-testid="session-grid-card"][data-tab-id="${tabId}"] [data-testid="session-grid-card-hide"]`
  )!
}

/** Opens the view menu (Radix opens on pointerdown) and returns the reveal checkbox. */
function openRevealItem(): HTMLElement {
  fireEvent.pointerDown(screen.getByTestId('session-grid-view-menu'), { button: 0 })
  return screen.getByTestId('session-grid-reveal-hidden')
}

function stateChip(bucket: string): HTMLElement {
  return screen
    .getAllByTestId('session-grid-state-chip')
    .find((chip) => chip.getAttribute('data-value') === bucket)!
}

describe('session grid filter and hide', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    resetTerminalTabActivityFlagsCacheForTest()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('reflows the grid when a state chip narrows it, empty slots included', () => {
    seedCards(4, { 0: 'blocked', 1: 'working', 2: 'done' })
    render(<SessionsGridPage />)

    // `auto` with four cards is 2x2, and a whole spare row is kept below them.
    expect(renderedTabIds()).toHaveLength(4)
    expect(gridColumns()).toBe(2)
    expect(screen.getAllByTestId('session-grid-empty-slot')).toHaveLength(2)
    expect(stateChip('all')).toHaveAttribute('data-current', 'true')

    fireEvent.click(stateChip('working'))

    // One card left, so the preset resolves to a single column: the slot counts and
    // the preset both derive from `items.length`, and the state axis feeds it.
    expect(renderedTabIds()).toEqual(['tab-1'])
    expect(gridColumns()).toBe(1)
    expect(screen.getAllByTestId('session-grid-empty-slot')).toHaveLength(1)
    expect(stateChip('working')).toHaveAttribute('data-current', 'true')
    expect(stateChip('all')).not.toHaveAttribute('data-current')
  })

  it('hides a card from its header without moving the cards around it', () => {
    seedCards(3)
    render(<SessionsGridPage />)
    expect(renderedTabIds()).toEqual(['tab-0', 'tab-1', 'tab-2'])

    const middle = screen.getAllByTestId('session-grid-card')[1]!
    fireEvent.click(middle.querySelector('[data-testid="session-grid-card-hide"]')!)

    expect(renderedTabIds()).toEqual(['tab-0', 'tab-2'])
    // The card is out of the view, not out of the session: the pty and the tab stay.
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(3)
    expect(useAppStore.getState().sessionsGridHiddenTabIds).toEqual(['tab-1'])
  })

  it('reveals hidden cards in place from the view menu, dimmed', () => {
    seedCards(3)
    render(<SessionsGridPage />)

    act(() => useAppStore.getState().toggleSessionsGridHiddenTab('tab-1'))
    const item = openRevealItem()
    expect(item).toHaveAttribute('data-count', '1')
    expect(item).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(item)

    expect(renderedTabIds()).toEqual(['tab-0', 'tab-1', 'tab-2'])
    const revealed = screen.getAllByTestId('session-grid-card')[1]!
    expect(revealed).toHaveAttribute('data-hidden-from-grid', 'true')
    expect(revealed.className).toContain('opacity-60')
    expect(screen.getByTestId('session-grid-reveal-hidden')).toHaveAttribute('aria-checked', 'true')
  })

  it('drops the reveal mode with the last hidden card, instead of leaving it stuck on', () => {
    seedCards(3)
    render(<SessionsGridPage />)

    // Hide one, reveal it, then show it again from the card that is now on screen.
    fireEvent.click(hideButtonOf('tab-0'))
    fireEvent.click(openRevealItem())
    expect(screen.getByTestId('session-grid-reveal-hidden')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(hideButtonOf('tab-0'))

    // With nothing hidden the switch goes dead, so the mode has to go with it: otherwise
    // the next Hide leaves its card dimmed in place, looking broken.
    expect(screen.getByTestId('session-grid-reveal-hidden')).toHaveAttribute('data-disabled', '')
    fireEvent.click(hideButtonOf('tab-1'))
    expect(renderedTabIds()).toEqual(['tab-0', 'tab-2'])
    expect(screen.getByTestId('session-grid-reveal-hidden')).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })

  it('never scrolls the toolbar sideways: the workspace axis is a picker, not a chip row', () => {
    seedCards(2)
    render(<SessionsGridPage />)

    // happy-dom lays nothing out, so this pins the structure: one picker for the workspace
    // axis, and no overflow container anywhere in the toolbar for it to scroll inside.
    const picker = screen.getByTestId('session-grid-workspace-picker')
    expect(picker).toHaveAttribute('data-value', 'all')
    const toolbar = picker.closest<HTMLElement>('.\\@container\\/toolbar')!
    expect(toolbar).not.toBeNull()
    expect(toolbar.querySelector('[class*="overflow-x-auto"]')).toBeNull()
  })

  it('keeps the card header and the tab bar menu on the same answer', () => {
    const tabs = seedCards(2)
    render(<SessionsGridPage />)

    const menuProps = {
      tab: tabs[0]!,
      unifiedTabId: 'tab-0',
      groupId: 'group-1',
      isActive: true,
      open: true,
      point: { x: 0, y: 0 },
      tabCount: 2,
      hasTabsToRight: true,
      hasTabsToLeft: false,
      isPinned: false,
      onOpenChange: () => {},
      onActivate: () => {},
      onClose: () => {},
      onCloseOthers: () => {},
      onCloseToRight: () => {},
      onCloseToLeft: () => {},
      onRenameOpen: () => {},
      onSetTabColor: () => {},
      onTogglePin: () => {}
    }
    const menu = render(<SortableTabContextMenu {...menuProps} />)
    const menuItem = (): HTMLElement =>
      menu.getByTestId('tab-context-menu-grid-visibility') as HTMLElement

    expect(menuItem()).toHaveTextContent(sessionGridVisibilityActionLabel(false))

    // Hidden from the card: the menu flips to the inverse action on the same tab.
    fireEvent.click(
      screen
        .getAllByTestId('session-grid-card')[0]!
        .querySelector('[data-testid="session-grid-card-hide"]')!
    )
    expect(renderedTabIds()).toEqual(['tab-1'])
    expect(menuItem()).toHaveTextContent(sessionGridVisibilityActionLabel(true))

    // And back from the menu: the card returns to the grid, undimmed.
    fireEvent.click(menuItem())
    expect(renderedTabIds()).toEqual(['tab-0', 'tab-1'])
    expect(screen.getAllByTestId('session-grid-card')[0]!.className).not.toContain('opacity-60')
    expect(menuItem()).toHaveTextContent(sessionGridVisibilityActionLabel(false))
  })
})
