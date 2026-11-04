import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { isInactiveWorkspace } from '../lib/worktree-activity-state'
import { clearWorktreeSleepIntent, markWorktreeSleepIntent } from '../lib/worktree-sleep-intent'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))

const TAB_ID = toWebTerminalSurfaceTabId('host-tab-1')
const PTY_ID = `remote:${ENV}@@terminal-1`
const FOLDER = 'folder:folder-1'

function sleptState(worktreeId = WT, ptyId = PTY_ID) {
  return makeState({
    activeWorktreeId: 'another-workspace',
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: TAB_ID,
          ptyId,
          worktreeId,
          title: 'shell',
          defaultTitle: 'shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: NOW
        }
      ]
    },
    ptyIdsByTabId: { [TAB_ID]: [] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: ptyId }
      }
    }
  })
}

function pendingSnapshot(worktreeId = WT) {
  return makeSnapshot(
    [
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'shell',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'pending-handle',
        terminal: null
      }
    ],
    { worktree: worktreeId }
  )
}

function inactive(state: ReturnType<typeof makeState>, worktreeId = WT) {
  return isInactiveWorkspace(worktreeId, state.tabsByWorktree, state.ptyIdsByTabId, {}, new Set())
}

describe('sleep activity during host terminal mirroring', () => {
  beforeEach(resetWebSessionTabsSyncTestState)
  afterEach(() => {
    clearWorktreeSleepIntent(WT)
    clearWorktreeSleepIntent(FOLDER)
  })

  it.each([WT, FOLDER])('keeps %s asleep while retaining its wake binding', (worktreeId) => {
    const state = sleptState(worktreeId)
    markWorktreeSleepIntent(worktreeId)
    expect(inactive(state, worktreeId)).toBe(true)

    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, pendingSnapshot(worktreeId), ENV, NOW + 1)
    }

    expect(next.terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId).toEqual({ [LEAF_ID]: PTY_ID })
    expect(next.tabsByWorktree[worktreeId]?.[0]?.ptyId).toBe(PTY_ID)
    expect(next.ptyIdsByTabId[TAB_ID] ?? []).toEqual([])
    expect(inactive(next, worktreeId)).toBe(true)
    expect(next.activeWorktreeId).toBe('another-workspace')
  })
})
