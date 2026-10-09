import '../../src/renderer/src/store/slices/terminal-hydration-store-test-bootstrap'
import { describe, expect, it, vi } from 'vitest'
import { applyPtyBinding } from '../../src/main/persistence/loading-store/pty-binding-session-update'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import { folderWorkspaceKey } from '../../src/shared/workspace-scope'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import { reconcileHydratedWorkspaceTabModels } from '../../src/renderer/src/app-shell/reconcile-hydrated-workspace-tab-models'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '../../src/renderer/src/store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

const TAB_ID = 'crash-survivor'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const INCARNATION_ID = '22222222-2222-4222-8222-222222222222'
const FOLDER_KEY = folderWorkspaceKey('crash-folder')

describe.each(['repo1::/repo1', FOLDER_KEY])('binding crash hydration for %s', (worktreeId) => {
  it.each([false, true])(
    'restores the acknowledged terminal before a renderer snapshot (existing row: %s)',
    async (existingRow) => {
      const ptyId = `${worktreeId}@@surviving-pty`
      const persisted: WorkspaceSessionState = {
        ...getDefaultWorkspaceSession(),
        activeWorktreeId: worktreeId,
        activeTabId: TAB_ID,
        activeTabIdByWorktree: { [worktreeId]: TAB_ID },
        activeWorktreeIdsOnShutdown: [],
        unifiedTabs: {},
        tabGroups: {},
        tabGroupLayouts: {},
        ...(existingRow
          ? { tabsByWorktree: { [worktreeId]: [makeTab({ id: TAB_ID, worktreeId, ptyId: null })] } }
          : {})
      }
      applyPtyBinding(
        { worktreeId, tabId: TAB_ID, leafId: LEAF_ID, ptyId, incarnationId: INCARNATION_ID },
        persisted,
        worktreeId,
        `${TAB_ID}:${LEAF_ID}`
      )

      // A crash leaves only the binding transaction; no renderer snapshot can fill its gaps.
      const restoredSession = structuredClone(persisted)
      const store = createTestStore()
      store.setState({
        repos: [TEST_REPO],
        worktreesByRepo: {
          repo1: [makeWorktree({ id: 'repo1::/repo1', repoId: 'repo1', path: '/repo1' })]
        }
      })
      const options = { additionalValidWorkspaceKeys: [FOLDER_KEY] }
      store.getState().hydrateWorkspaceSession(restoredSession, options)
      store.getState().hydrateTabsSession(restoredSession, options)
      reconcileHydratedWorkspaceTabModels(
        restoredSession,
        store.getState().reconcileWorktreeTabModels
      )

      const beforeReconnect = store.getState()
      expect(beforeReconnect.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([TAB_ID])
      expect(beforeReconnect.pendingReconnectPtyIdByTabId[TAB_ID]).toBe(ptyId)
      expect(beforeReconnect.unifiedTabsByWorktree[worktreeId]).toEqual([
        expect.objectContaining({ id: TAB_ID, entityId: TAB_ID, contentType: 'terminal' })
      ])
      expect(beforeReconnect.groupsByWorktree[worktreeId]).toEqual([
        expect.objectContaining({ activeTabId: TAB_ID, tabOrder: [TAB_ID] })
      ])
      expect(beforeReconnect.layoutByWorktree[worktreeId]).toEqual({
        type: 'leaf',
        groupId: beforeReconnect.groupsByWorktree[worktreeId][0].id
      })
      expect(beforeReconnect.terminalLayoutsByTabId[TAB_ID]).toMatchObject({
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        ptyIdsByLeafId: { [LEAF_ID]: ptyId }
      })
      expect(restoredSession.terminalPtyIncarnationsByPaneKey?.[`${TAB_ID}:${LEAF_ID}`]).toBe(
        INCARNATION_ID
      )

      await store.getState().reconnectPersistedTerminals()

      expect(store.getState().workspaceSessionReady).toBe(true)
      expect(store.getState().activeTabId).toBe(TAB_ID)
      expect(store.getState().tabsByWorktree[worktreeId]).toEqual([
        expect.objectContaining({ id: TAB_ID, ptyId })
      ])
      expect(store.getState().ptyIdsByTabId[TAB_ID]).toEqual([ptyId])
    }
  )
})
