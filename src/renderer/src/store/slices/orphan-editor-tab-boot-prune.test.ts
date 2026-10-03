import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { Tab } from '../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { reconcileHydratedWorkspaceTabModels } from '../../app-shell/reconcile-hydrated-workspace-tab-models'
import { buildPersistedUnifiedTabSessionData } from '../../lib/workspace-session-unified-tabs'
import { buildOwnedEditorFileId } from './editor/file-ids/editor-file-ids'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { createTestStore, makeWorktree } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const WORKTREE_ID = 'repo-1::/x'
const FILE_PATH = '/x/README.md'
const GROUP_ID = 'group-1'
const LIVE_FILE_ID = buildOwnedEditorFileId(FILE_PATH, WORKTREE_ID, 'env-a')
const ORPHAN_FILE_ID = buildOwnedEditorFileId(FILE_PATH, WORKTREE_ID, 'env-b')

function prepareStore() {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo-1', path: '/x', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: '/x' })]
    },
    activeWorktreeId: null
  })
  return store
}

function editorTab(entityId: string): Tab {
  return {
    id: 'tab-readme',
    entityId,
    groupId: GROUP_ID,
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label: 'README.md',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function sessionWithEditorTab(
  entityId: string,
  tabsByWorktree: WorkspaceSessionState['tabsByWorktree'] = {}
): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree,
    terminalLayoutsByTabId: {},
    openFilesByWorktree: {
      [WORKTREE_ID]: [
        {
          filePath: FILE_PATH,
          relativePath: 'README.md',
          worktreeId: WORKTREE_ID,
          language: 'markdown',
          runtimeEnvironmentId: 'env-a'
        }
      ]
    },
    unifiedTabs: { [WORKTREE_ID]: [editorTab(entityId)] },
    tabGroups: {
      [WORKTREE_ID]: [
        {
          id: GROUP_ID,
          worktreeId: WORKTREE_ID,
          activeTabId: 'tab-readme',
          tabOrder: ['tab-readme']
        }
      ]
    },
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID }
  }
}

function boot(session: WorkspaceSessionState) {
  const store = prepareStore()
  store.getState().hydrateTabsSession(session)
  store.getState().hydrateEditorSession(session)
  // Precondition: the tab and its (possibly mismatched) record both survived hydration.
  expect(store.getState().openFiles.map((file) => file.id)).toEqual([LIVE_FILE_ID])
  expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
    'tab-readme'
  ])
  reconcileHydratedWorkspaceTabModels(session, store.getState().reconcileWorktreeTabModels)
  const state = store.getState()
  return { state, persisted: buildPersistedUnifiedTabSessionData(state) }
}

describe('boot-time orphan editor tab pruning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('drops an editor tab with no OpenFile in a workspace without terminal rows', () => {
    const { state, persisted } = boot(sessionWithEditorTab(ORPHAN_FILE_ID))

    expect(state.unifiedTabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    const tabOrders = (state.groupsByWorktree[WORKTREE_ID] ?? []).flatMap((g) => g.tabOrder)
    expect(tabOrders).not.toContain('tab-readme')
    expect(persisted.unifiedTabs?.[WORKTREE_ID]).toBeUndefined()
  })

  it('keeps an editor tab whose OpenFile is live', () => {
    const { state, persisted } = boot(sessionWithEditorTab(LIVE_FILE_ID))

    expect(state.unifiedTabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['tab-readme'])
    expect(persisted.unifiedTabs?.[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['tab-readme'])
  })

  it('still drops the orphan when the workspace has an empty terminal row', () => {
    const { state, persisted } = boot(sessionWithEditorTab(ORPHAN_FILE_ID, { [WORKTREE_ID]: [] }))

    expect(state.unifiedTabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(persisted.unifiedTabs?.[WORKTREE_ID]).toBeUndefined()
  })
})
