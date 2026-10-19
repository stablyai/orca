import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { isInactiveWorkspace } from '../lib/worktree-activity-state'
import { clearWorktreeSleepIntent, markWorktreeSleepIntent } from '../lib/worktree-sleep-intent'
import { listResult } from './__fixtures__/web-session-terminal-orphan-recovery-regression-fixtures'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
import type { TerminalOrphanRecoveryCall } from './web-session-terminal-orphan-recovery-adoption'
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
const HANDLE = 'terminal-1'
const PTY_ID = `remote:${ENV}@@${HANDLE}`
const FOLDER = 'folder:folder-1'

// Sleep keeps the layout binding as the wake binding and clears only the live map.
function sleptState(worktreeId: string, livePtyIds: string[] = []) {
  return makeState({
    activeWorktreeId: 'another-workspace',
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: TAB_ID,
          ptyId: PTY_ID,
          worktreeId,
          title: 'claude',
          defaultTitle: 'claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: NOW
        }
      ]
    },
    activeTabIdByWorktree: { [worktreeId]: TAB_ID },
    ptyIdsByTabId: { [TAB_ID]: livePtyIds },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    }
  })
}

function pendingFrame(worktreeId: string): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    [
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'claude',
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

function inactive(state: ReturnType<typeof makeState>, worktreeId: string): boolean {
  return isInactiveWorkspace(worktreeId, state.tabsByWorktree, state.ptyIdsByTabId, {}, new Set())
}

function listed(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'list', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function listCall(listing: () => RuntimeRpcResponse<unknown>) {
  return vi.fn<TerminalOrphanRecoveryCall>(async ({ method }) => {
    if (method !== 'terminal.list') {
      throw new Error(`unexpected ${method}`)
    }
    return listing()
  })
}

const INVENTORIES = [
  {
    name: 'a complete inventory',
    listing: () => listed(listResult(WT, []))
  },
  {
    name: 'an older host inventory without hostScope',
    listing: () => listed({ ...listResult(WT, []), hostScope: undefined })
  },
  {
    name: 'a truncated inventory',
    listing: () => listed(listResult(WT, [], { truncated: true }))
  },
  {
    name: 'a failed inventory',
    listing: (): RuntimeRpcResponse<unknown> => {
      throw new Error('connection lost')
    }
  }
]

describe('terminal orphan recovery of a slept workspace (#30108)', () => {
  beforeEach(() => {
    clearWebSessionTerminalOrphanRecoveryForTests()
    resetWebSessionTabsSyncTestState()
  })
  afterEach(() => {
    clearWorktreeSleepIntent(WT)
    clearWorktreeSleepIntent(FOLDER)
  })

  it.each(
    [WT, FOLDER].flatMap((worktreeId) =>
      INVENTORIES.map((inventory) => ({ worktreeId, ...inventory }))
    )
  )('keeps $worktreeId asleep when $name omits its handle', async ({ worktreeId, listing }) => {
    const state = sleptState(worktreeId)
    markWorktreeSleepIntent(worktreeId)
    const frame = pendingFrame(worktreeId)
    const call = listCall(listing)

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(state, frame, ENV, {
      call
    })

    expect(call).toHaveBeenCalledOnce()
    expect(recovered?.tabs).toEqual([
      expect.objectContaining({
        leafId: LEAF_ID,
        status: 'pending-handle',
        terminal: null
      })
    ])
    const applied = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, recovered!, ENV, NOW + 1)
    }
    expect(applied.terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId).toEqual({
      [LEAF_ID]: PTY_ID
    })
    expect(applied.ptyIdsByTabId[TAB_ID] ?? []).toEqual([])
    expect(inactive(applied, worktreeId)).toBe(true)
  })

  it('keeps an already-live binding live through the same pending gap', async () => {
    const state = sleptState(WT, [PTY_ID])
    const call = listCall(() => listed(listResult(WT, [])))

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      pendingFrame(WT),
      ENV,
      { call }
    )
    const applied = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, recovered!, ENV, NOW + 1)
    }

    expect(applied.terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId).toEqual({
      [LEAF_ID]: PTY_ID
    })
    expect(applied.ptyIdsByTabId[TAB_ID]).toEqual([PTY_ID])
    expect(inactive(applied, WT)).toBe(false)
  })
})
