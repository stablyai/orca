import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { loadWorkspaceLayout } from '../../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  addWorkspace,
  emptySession,
  FOLDER_KEY,
  GIT_KEY,
  leaf
} from '../../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'
import { createTestStore } from '../store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

describe('ensureWorktreeRootGroup', () => {
  it.each([GIT_KEY, FOLDER_KEY])('mints the group main mints for %s', (workspaceKey) => {
    const stored = addWorkspace(emptySession(), workspaceKey, [
      { id: 'g1', tabs: [{ id: 'tab-a', leaves: [[leaf(1), 'pty-a']] }] }
    ])
    stored.unifiedTabs = {}
    stored.tabGroups = {}
    stored.tabGroupLayouts = {}
    const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, stored, nameBasedLoadContext())

    const groupId = createTestStore().getState().ensureWorktreeRootGroup(workspaceKey)

    expect(loaded.layout.workspaces[workspaceKey]?.groups.map((group) => group.id)).toEqual([
      groupId
    ])
  })
})
