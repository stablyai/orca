// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ActivityThreadContextMenu,
  getActivityThreadCopyTargets
} from './activity-thread-context-menu'
import type * as ActivityClearCompleted from './activity-clear-completed'
import type { AgentPaneThread } from './activity-thread-types'
import { makeRepo, makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

const mocks = vi.hoisted(() => ({ clearActivityThread: vi.fn() }))

vi.mock('./activity-clear-completed', async (importOriginal) => ({
  ...(await importOriginal<typeof ActivityClearCompleted>()),
  clearActivityThread: mocks.clearActivityThread
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

const handlers = {
  onOpen: vi.fn(),
  onJump: vi.fn(),
  onMarkRead: vi.fn(),
  onMarkUnread: vi.fn()
}

function openMenu(thread: AgentPaneThread, canJump = true, disableMarkUnread = false): void {
  render(
    <ActivityThreadContextMenu
      thread={thread}
      canJump={canJump}
      disableMarkUnread={disableMarkUnread}
      {...handlers}
    >
      {(menuOpen) => (
        <div data-testid="row" data-menu-open={menuOpen ? '' : undefined}>
          row
        </div>
      )}
    </ActivityThreadContextMenu>
  )
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
    openMenu(makeThread({ unread: false }), true, true)

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
