import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import {
  clearWorktreeSleepIntent,
  markWorktreeSleepIntent
} from '../../../lib/workspace/sleep/worktree-sleep-intent'
import { clearWebSessionTerminalOrphanRecoveryForTests } from './web-session-terminal-orphan-recovery'
import { applyWebSessionTabsSnapshot } from '../../web-session-tabs-sync/snapshot-api'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'

vi.mock('../../../store/index', () => ({ useAppStore: { setState: vi.fn() } }))

const TAB_ID = toWebTerminalSurfaceTabId('host-tab-1')
const HANDLE = 'terminal-1'
const PTY_ID = `remote:${ENV}@@${HANDLE}`
const FOLDER = 'folder:folder-1'

// Sleep keeps the layout binding as the wake binding and clears only the live map.
function sleptState(worktreeId: string) {
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
    ptyIdsByTabId: { [TAB_ID]: [] },
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

describe('terminal orphan recovery of a slept workspace (#30108)', () => {
  beforeEach(() => {
    clearWebSessionTerminalOrphanRecoveryForTests()
    resetWebSessionTabsSyncTestState()
  })
  afterEach(() => {
    clearWorktreeSleepIntent(WT)
    clearWorktreeSleepIntent(FOLDER)
  })

  it('retains the wake binding without reviving a slept folder when applying a pending frame', () => {
    const state = sleptState(FOLDER)
    markWorktreeSleepIntent(FOLDER)

    const applied = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, pendingFrame(FOLDER), ENV, NOW + 1)
    }

    expect(applied.terminalLayoutsByTabId['web-terminal-host-tab-1']?.ptyIdsByLeafId).toEqual({
      '11111111-1111-4111-8111-111111111111': 'remote:web-env-1@@terminal-1'
    })
    expect(applied.ptyIdsByTabId['web-terminal-host-tab-1'] ?? []).toEqual([])
  })
})
