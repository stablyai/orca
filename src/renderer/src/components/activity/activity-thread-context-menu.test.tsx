// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'
import {
  ActivityThreadContextMenu,
  getActivityThreadCopyTargets
} from './activity-thread-context-menu'
import type * as ActivityClearCompleted from './activity-clear-completed'
import type { AgentPaneThread } from './activity-thread-types'
import { makeRepo, makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

const mocks = vi.hoisted(() => ({ clearActivityThread: vi.fn(), clearCompletedActivity: vi.fn() }))

vi.mock('./activity-clear-completed', async (importOriginal) => ({
  ...(await importOriginal<typeof ActivityClearCompleted>()),
  clearActivityThread: mocks.clearActivityThread,
  clearCompletedActivity: mocks.clearCompletedActivity
}))

function makeThread(overrides: Partial<AgentPaneThread> = {}): AgentPaneThread {
  return {
    paneKey: 'tab-1:leaf-1',
    paneTitle: 'Fix the flaky test',
    worktree: { ...makeWorktree(), branch: 'refs/heads/feat/flaky' },
    repo: makeRepo(),
    tab: makeTab(),
    agentType: 'claude',
    currentAgentState: 'working',
    currentAgentEntry: null,
    responsePreview: '',
    latestTimestamp: 1000,
    latestEvent: null,
    events: [],
    unread: true,
    ...overrides
  }
}

function makeDoneThread(paneKey: string, overrides: Partial<AgentPaneThread> = {}) {
  return makeThread({
    paneKey,
    currentAgentState: null,
    paneEntry: {
      state: 'done',
      prompt: '',
      updatedAt: 1000,
      stateStartedAt: 1000,
      agentType: 'claude',
      paneKey,
      stateHistory: []
    },
    ...overrides
  })
}

const handlers = {
  onOpen: vi.fn(),
  onJump: vi.fn(),
  onMarkRead: vi.fn(),
  onMarkUnread: vi.fn(),
  onMarkManyRead: vi.fn(),
  onMarkManyUnread: vi.fn()
}

function renderMenu(
  thread: AgentPaneThread,
  {
    canJump = true,
    canMarkUnread = () => true,
    getTargets,
    testId = 'row'
  }: {
    canJump?: boolean
    canMarkUnread?: (thread: AgentPaneThread) => boolean
    getTargets?: (thread: AgentPaneThread) => readonly AgentPaneThread[]
    testId?: string
  } = {}
): void {
  render(
    <ActivityThreadContextMenu
      thread={thread}
      canJump={canJump}
      canMarkUnread={canMarkUnread}
      getTargets={getTargets}
      {...handlers}
    >
      {(menuOpen) => (
        <div data-testid={testId} data-menu-open={menuOpen ? '' : undefined}>
          row
        </div>
      )}
    </ActivityThreadContextMenu>
  )
}

function openMenu(thread: AgentPaneThread, canJump = true): void {
  renderMenu(thread, { canJump })
  fireEvent.contextMenu(screen.getByTestId('row'))
}

function openBulkMenu(
  targets: readonly AgentPaneThread[],
  canMarkUnread: (thread: AgentPaneThread) => boolean = () => true
): void {
  renderMenu(targets[0], { canMarkUnread, getTargets: () => targets })
  fireEvent.contextMenu(screen.getByTestId('row'))
}

function menuItem(name: string): HTMLElement {
  return screen.getByRole('menuitem', { name })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ActivityThreadContextMenu', () => {
  it('opens the thread', () => {
    const thread = makeThread()
    openMenu(thread)

    fireEvent.click(menuItem('Open'))
    expect(handlers.onOpen).toHaveBeenCalledWith(thread)
  })

  it('shows one read toggle that marks an unread thread read', () => {
    const thread = makeThread()
    openMenu(thread)

    expect(screen.queryByRole('menuitem', { name: 'Mark Unread' })).toBeNull()
    fireEvent.click(menuItem('Mark Read'))
    expect(handlers.onMarkRead).toHaveBeenCalledWith(thread)
  })

  it('shows one read toggle that marks a read thread unread', () => {
    const thread = makeThread({ unread: false })
    openMenu(thread)

    expect(screen.queryByRole('menuitem', { name: 'Mark Read' })).toBeNull()
    fireEvent.click(menuItem('Mark Unread'))
    expect(handlers.onMarkUnread).toHaveBeenCalledWith(thread)
  })

  it('disables Mark Unread for the open thread', () => {
    renderMenu(makeThread({ unread: false }), { canMarkUnread: () => false })
    fireEvent.contextMenu(screen.getByTestId('row'))

    expect(menuItem('Mark Unread').hasAttribute('data-disabled')).toBe(true)
  })

  it('lists copy actions flat instead of in a submenu', () => {
    openMenu(makeThread())

    expect(menuItem('Copy Path')).toBeTruthy()
    expect(menuItem('Copy Title')).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Copy Branch' })).toBeNull()
  })

  it('tells the row while the menu is open so it can keep its preview closed', () => {
    openMenu(makeThread())
    expect(screen.getByTestId('row').hasAttribute('data-menu-open')).toBe(true)

    fireEvent.keyDown(menuItem('Open'), { key: 'Escape' })
    expect(screen.getByTestId('row').hasAttribute('data-menu-open')).toBe(false)
  })

  it('offers Go to Workspace only for threads with a real workspace', () => {
    openMenu(makeThread(), false)

    expect(screen.queryByRole('menuitem', { name: 'Go to Workspace' })).toBeNull()
  })

  it('offers Clear from List only for finished threads', () => {
    const done = makeThread({
      currentAgentState: null,
      paneEntry: {
        state: 'done',
        prompt: '',
        updatedAt: 1000,
        stateStartedAt: 1000,
        agentType: 'claude',
        paneKey: 'tab-1:leaf-1',
        stateHistory: []
      }
    })
    openMenu(done)

    fireEvent.click(menuItem('Clear from List'))
    expect(mocks.clearActivityThread).toHaveBeenCalledWith(done)
    cleanup()

    openMenu(makeThread())
    expect(screen.queryByRole('menuitem', { name: 'Clear from List' })).toBeNull()
  })

  it('acts on every target with counted labels and hides single-agent actions', () => {
    const unreadA = makeThread({ paneKey: 'a', unread: true })
    const readB = makeDoneThread('b', { unread: false })
    const readC = makeDoneThread('c', { unread: false })
    openBulkMenu([unreadA, readB, readC])

    expect(screen.queryByRole('menuitem', { name: 'Open' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Go to Workspace' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Copy Title' })).toBeNull()
    expect(screen.getByText('Agent')).toBeTruthy()

    expect(screen.queryByRole('menuitem', { name: /Unread/ })).toBeNull()
    fireEvent.click(menuItem('Mark 1 Agent Read'))
    expect(handlers.onMarkManyRead).toHaveBeenCalledWith([unreadA])
  })

  it('marks unread only the read targets that may be marked unread', () => {
    const openRow = makeThread({ paneKey: 'open', unread: false })
    const readB = makeThread({ paneKey: 'b', unread: false })
    openBulkMenu([openRow, readB], (thread) => thread.paneKey !== 'open')

    fireEvent.click(menuItem('Mark 1 Agent Unread'))
    expect(handlers.onMarkManyUnread).toHaveBeenCalledWith([readB])
  })

  it('clears only the clearable targets through the undoable bulk clear', () => {
    const doneA = makeDoneThread('a')
    const working = makeThread({ paneKey: 'w' })
    const doneB = makeDoneThread('b')
    openBulkMenu([doneA, working, doneB])

    fireEvent.click(menuItem('Clear 2 Agents from List'))
    expect(mocks.clearCompletedActivity).toHaveBeenCalledWith([doneA, doneB])
    expect(mocks.clearActivityThread).not.toHaveBeenCalled()
  })

  it('disables bulk actions with nothing to act on and drops their count', () => {
    openBulkMenu(
      [makeThread({ paneKey: 'a', unread: false }), makeThread({ paneKey: 'b', unread: false })],
      () => false
    )

    expect(menuItem('Mark Unread').hasAttribute('data-disabled')).toBe(true)
    expect(menuItem('Clear from List').hasAttribute('data-disabled')).toBe(true)
  })

  it('shows the single-agent menu when the targets are just the clicked row', () => {
    const thread = makeThread()
    renderMenu(thread, { getTargets: () => [thread] })
    fireEvent.contextMenu(screen.getByTestId('row'))

    expect(menuItem('Open')).toBeTruthy()
    expect(menuItem('Mark Read')).toBeTruthy()
  })

  it('announces itself to other menus on open and closes when another menu opens', () => {
    const onCloseAll = vi.fn()
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, onCloseAll)
    openMenu(makeThread())
    expect(onCloseAll).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('row').hasAttribute('data-menu-open')).toBe(true)

    act(() => {
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    })
    expect(screen.getByTestId('row').hasAttribute('data-menu-open')).toBe(false)
    expect(screen.queryByRole('menu')).toBeNull()
    window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, onCloseAll)
  })

  it('copies the path, then the title, of a real workspace like the workspace menu', () => {
    expect(getActivityThreadCopyTargets(makeThread(), true)).toEqual([
      { key: 'path', label: 'Copy Path', value: '/repo/wt-1' },
      { key: 'title', label: 'Copy Title', value: 'Fix the flaky test' }
    ])
  })

  it('offers only the title for a synthetic terminal without a workspace', () => {
    const synthetic = makeThread({
      worktree: { ...makeWorktree(), path: '', branch: 'Floating terminal' }
    })

    expect(getActivityThreadCopyTargets(synthetic, false)).toEqual([
      { key: 'title', label: 'Copy Title', value: 'Fix the flaky test' }
    ])
  })
})
