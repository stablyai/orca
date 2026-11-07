import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { resolveTerminalTabStripDropTarget } from '../../terminal-tab-strip-drop-target'
import {
  EXISTING_TAB_1,
  EXISTING_TAB_2,
  TARGET_GROUP_ID,
  WORKTREE_ID
} from './terminal-pane-tab-detach-fixture'

const toastErrorMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

beforeEach(() => {
  toastErrorMock.mockClear()
  // No local main holds these sessions, so each move stays in the renderer.
  vi.stubGlobal('window', {
    api: { pty: { moveLeafToNewTab: () => Promise.resolve({ status: 'not_held' }) } }
  })
})

function rect(args: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    left: args.left,
    top: args.top,
    right: args.left + args.width,
    bottom: args.top + args.height,
    width: args.width,
    height: args.height
  } as DOMRect
}

describe('resolveTerminalTabStripDropTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('finds a same-worktree tab strip under overlay elements', () => {
    const stripRect = rect({ left: 0, top: 0, width: 300, height: 32 })
    const strip = {
      dataset: { tabGroupStripId: TARGET_GROUP_ID, worktreeId: WORKTREE_ID },
      getBoundingClientRect: () => stripRect,
      querySelectorAll: () => []
    }
    const overlay = { closest: () => null }
    const child = { closest: () => strip }
    vi.stubGlobal('document', {
      elementsFromPoint: vi.fn(() => [overlay, child]),
      elementFromPoint: vi.fn()
    })

    expect(
      resolveTerminalTabStripDropTarget({
        clientX: 10,
        clientY: 10,
        groupsByWorktree: {
          [WORKTREE_ID]: [{ id: TARGET_GROUP_ID } as AppState['groupsByWorktree'][string][number]]
        },
        worktreeId: WORKTREE_ID
      })
    ).toEqual({
      id: TARGET_GROUP_ID,
      groupId: TARGET_GROUP_ID,
      worktreeId: WORKTREE_ID,
      rect: stripRect
    })
  })

  it('resolves the insertion slot from the hovered tab side', () => {
    const stripRect = rect({ left: 0, top: 0, width: 300, height: 32 })
    const firstTabRect = rect({ left: 0, top: 0, width: 80, height: 32 })
    const secondTabRect = rect({ left: 80, top: 0, width: 80, height: 32 })
    const firstTab = {
      dataset: { tabId: EXISTING_TAB_1 },
      getBoundingClientRect: () => firstTabRect
    }
    const secondTab = {
      dataset: { tabId: EXISTING_TAB_2 },
      getBoundingClientRect: () => secondTabRect
    }
    const strip = {
      dataset: { tabGroupStripId: TARGET_GROUP_ID, worktreeId: WORKTREE_ID },
      getBoundingClientRect: () => stripRect,
      querySelectorAll: () => [firstTab, secondTab]
    }
    vi.stubGlobal('document', {
      elementsFromPoint: vi.fn(() => [{ closest: () => firstTab }, { closest: () => strip }]),
      elementFromPoint: vi.fn()
    })

    expect(
      resolveTerminalTabStripDropTarget({
        clientX: 60,
        clientY: 10,
        groupsByWorktree: {
          [WORKTREE_ID]: [
            {
              id: TARGET_GROUP_ID,
              activeTabId: EXISTING_TAB_1,
              tabOrder: [EXISTING_TAB_1, EXISTING_TAB_2],
              worktreeId: WORKTREE_ID
            } as AppState['groupsByWorktree'][string][number]
          ]
        },
        worktreeId: WORKTREE_ID
      })
    ).toMatchObject({
      groupId: TARGET_GROUP_ID,
      insertionIndex: 1,
      overlayKind: 'insertion',
      rect: rect({ left: 80, top: 0, width: 2, height: 32 })
    })
  })

  it('ignores strips from another worktree', () => {
    const strip = {
      dataset: { tabGroupStripId: TARGET_GROUP_ID, worktreeId: 'other-worktree' },
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, right: 300, bottom: 32, width: 300, height: 32 }) as DOMRect
    }
    vi.stubGlobal('document', {
      elementsFromPoint: vi.fn(() => [{ closest: () => strip }]),
      elementFromPoint: vi.fn()
    })

    expect(
      resolveTerminalTabStripDropTarget({
        clientX: 10,
        clientY: 10,
        groupsByWorktree: {
          [WORKTREE_ID]: [{ id: TARGET_GROUP_ID } as AppState['groupsByWorktree'][string][number]]
        },
        worktreeId: WORKTREE_ID
      })
    ).toBeNull()
  })
})
