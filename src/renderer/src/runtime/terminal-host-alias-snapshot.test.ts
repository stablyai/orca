import { beforeEach, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { terminalHostAliasSchema } from '../../../shared/terminal-host-alias'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
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

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

beforeEach(resetWebSessionTabsSyncTestState)

it('updates a local host alias without creating rows under the different host worktree key', () => {
  const localWorktreeId = 'repo::/local-worktree'
  const alias: TerminalTab = {
    id: toWebTerminalSurfaceTabId('host-tab-1'),
    ptyId: null,
    worktreeId: localWorktreeId,
    title: 'old title',
    defaultTitle: 'old title',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW,
    hostTerminalAlias: terminalHostAliasSchema.parse({
      executionHostId: toRuntimeExecutionHostId(ENV),
      worktreeId: WT,
      tabId: 'host-tab-1',
      leafId: LEAF_ID
    })
  }
  const state = makeState({
    activeWorktreeId: localWorktreeId,
    tabsByWorktree: { [localWorktreeId]: [alias] }
  })
  const next = {
    ...state,
    ...applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    )
  }

  expect(next.tabsByWorktree[WT]).toBeUndefined()
  expect(next.unifiedTabsByWorktree[WT]).toBeUndefined()
  expect(next.tabsByWorktree[localWorktreeId]).toMatchObject([
    {
      id: alias.id,
      worktreeId: localWorktreeId,
      title: 'host shell',
      ptyId: 'remote:web-env-1@@terminal-1',
      hostTerminalAlias: alias.hostTerminalAlias,
      hostTerminalAliasGone: false
    }
  ])
  expect(next.terminalLayoutsByTabId[alias.id]).toMatchObject({
    ptyIdsByLeafId: { [LEAF_ID]: 'remote:web-env-1@@terminal-1' }
  })
})
