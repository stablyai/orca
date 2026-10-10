import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { isInactiveWorkspace } from '../lib/worktree-activity-state'
import { clearWorktreeSleepIntent, markWorktreeSleepIntent } from '../lib/worktree-sleep-intent'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
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

  it('does not turn a restored wake binding into live activity without a sleep marker', () => {
    const state = sleptState()
    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, pendingSnapshot(), ENV, NOW + 1)
    }
    expect(inactive(next)).toBe(true)
  })

  it('keeps a previously live binding during an ordinary reconnect', () => {
    const state = sleptState()
    state.ptyIdsByTabId[TAB_ID] = [PTY_ID]
    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, pendingSnapshot(), ENV, NOW + 1)
    }
    expect(next.ptyIdsByTabId[TAB_ID]).toEqual([PTY_ID])
    expect(inactive(next)).toBe(false)
  })

  it('publishes a ready replacement after explicit wake', () => {
    const state = sleptState()
    markWorktreeSleepIntent(WT)
    clearWorktreeSleepIntent(WT)
    const snapshot = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'shell',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-2'
      }
    ])
    const next = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW + 1) }
    expect(next.ptyIdsByTabId[TAB_ID]).toEqual([`remote:${ENV}@@terminal-2`])
    expect(inactive(next)).toBe(false)
  })

  it('counts only ready panes when a slept split sibling is still pending', () => {
    const state = sleptState()
    const snapshot = pendingSnapshot()
    snapshot.tabs.push({
      type: 'terminal',
      id: `host-tab-1::${SECOND_LEAF_ID}`,
      title: 'new shell',
      parentTabId: 'host-tab-1',
      leafId: SECOND_LEAF_ID,
      isActive: false,
      status: 'ready',
      terminal: 'terminal-2'
    })
    const next = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW + 1) }
    expect(next.terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId?.[LEAF_ID]).toBe(PTY_ID)
    expect(next.ptyIdsByTabId[TAB_ID]).toEqual([`remote:${ENV}@@terminal-2`])
    expect(inactive(next)).toBe(false)
  })

  it('keeps the wake binding inactive across repeated host updates', () => {
    const state = sleptState()
    const snapshot = pendingSnapshot()
    const next = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW + 1) }
    const updatedSnapshot = { ...snapshot, snapshotVersion: 2 }
    const updated = {
      ...next,
      ...applyWebSessionTabsSnapshot(next, updatedSnapshot, ENV, NOW + 2)
    }
    expect(inactive(updated)).toBe(true)
    expect(updated.terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId).toEqual({ [LEAF_ID]: PTY_ID })
  })

  it('keeps local-mode pending wake bindings out of live activity', () => {
    const state = sleptState(WT, 'local-pty')
    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, pendingSnapshot(), ENV, NOW + 1, {
        terminalPtyMode: 'local'
      })
    }
    expect(next.terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId).toEqual({ [LEAF_ID]: 'local-pty' })
    expect(inactive(next)).toBe(true)
  })
})
