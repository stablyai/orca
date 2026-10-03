/**
 * A draft that stranded-partition adoption carries into a host-won row has to come back as a tab.
 * The shape of the carried unified entry is not enough: hydration assigns editor ids by owner and
 * migrates tab ids between files that share a path, so this runs the real tab and editor hydration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { buildOwnedEditorFileId } from '../../../../shared/editor-file-id'
import { adoptStrandedHostPartitionSession } from '../../../../shared/workspace-session-stranded-partition-adoption'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { createTestStore, makeWorktree } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const WORKTREE_ID = 'repo-1::/workspace'
const SAME_PATH = '/workspace/src/same.ts'

function file(filePath: string, overrides: Partial<PersistedOpenFile> = {}): PersistedOpenFile {
  return {
    filePath,
    relativePath: filePath.slice('/workspace/'.length),
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    ...overrides
  }
}

function editorTab(id: string, sortOrder = 0): Tab {
  return {
    id,
    entityId: id,
    groupId: 'g1',
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

function group(tabOrder: string[]): TabGroup {
  return { id: 'g1', worktreeId: WORKTREE_ID, activeTabId: tabOrder[0] ?? null, tabOrder }
}

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

/** Adopt, then restore the result the way startup does. */
function restore(base: WorkspaceSessionState, host: WorkspaceSessionState) {
  const adopted = adoptStrandedHostPartitionSession(base, host).session
  const store = createTestStore()
  store.setState({
    repos: [
      { id: 'repo-1', path: '/workspace', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: '/workspace' })]
    },
    activeWorktreeId: WORKTREE_ID
  })
  store.getState().hydrateTabsSession(adopted)
  store.getState().hydrateEditorSession(adopted)
  return store.getState()
}

/** Every restored file paired with the editor tab that shows it, or null when none does. */
function visibleFiles(state: ReturnType<typeof restore>) {
  const tabs = state.unifiedTabsByWorktree[WORKTREE_ID] ?? []
  return state.openFiles.map((open) => ({
    runtime: open.runtimeEnvironmentId ?? null,
    draft: state.editorDrafts[open.id] ?? null,
    tab: tabs.find((tab) => tab.contentType === 'editor' && tab.entityId === open.id)?.id ?? null
  }))
}

describe('a carried draft through real hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a runtime-owned draft whose path the host holds for the local runtime', () => {
    const state = restore(
      session({
        openFilesByWorktree: {
          [WORKTREE_ID]: [
            file(SAME_PATH, { runtimeEnvironmentId: 'env-1', dirtyDraftContent: 'x' })
          ]
        }
      }),
      session({
        openFilesByWorktree: { [WORKTREE_ID]: [file(SAME_PATH)] },
        unifiedTabs: { [WORKTREE_ID]: [editorTab(SAME_PATH)] },
        tabGroups: { [WORKTREE_ID]: [group([SAME_PATH])] }
      })
    )

    expect(visibleFiles(state)).toEqual([
      { runtime: null, draft: null, tab: SAME_PATH },
      {
        runtime: 'env-1',
        draft: 'x',
        tab: buildOwnedEditorFileId(SAME_PATH, WORKTREE_ID, 'env-1')
      }
    ])
  })

  it('shows a local draft whose path the host holds for a runtime under the bare path', () => {
    // The host's own tab is persisted under the bare path, which hydration hands to the runtime
    // file; the carried local file has to be reached through its local owned id instead.
    const state = restore(
      session({
        openFilesByWorktree: { [WORKTREE_ID]: [file(SAME_PATH, { dirtyDraftContent: 'x' })] }
      }),
      session({
        openFilesByWorktree: {
          [WORKTREE_ID]: [file(SAME_PATH, { runtimeEnvironmentId: 'env-1' })]
        },
        unifiedTabs: { [WORKTREE_ID]: [editorTab(SAME_PATH)] },
        tabGroups: { [WORKTREE_ID]: [group([SAME_PATH])] }
      })
    )

    expect(visibleFiles(state)).toEqual([
      {
        runtime: 'env-1',
        draft: null,
        tab: buildOwnedEditorFileId(SAME_PATH, WORKTREE_ID, 'env-1')
      },
      { runtime: null, draft: 'x', tab: SAME_PATH }
    ])
  })

  it('keeps the bare path as the tab id of an ordinary local draft', () => {
    const draftPath = '/workspace/src/draft.ts'
    const state = restore(
      session({
        openFilesByWorktree: { [WORKTREE_ID]: [file(draftPath, { dirtyDraftContent: 'x' })] }
      }),
      session({
        openFilesByWorktree: { [WORKTREE_ID]: [file('/workspace/src/host.ts')] },
        unifiedTabs: { [WORKTREE_ID]: [editorTab('/workspace/src/host.ts')] },
        tabGroups: { [WORKTREE_ID]: [group(['/workspace/src/host.ts'])] }
      })
    )

    expect(visibleFiles(state)).toEqual([
      { runtime: null, draft: null, tab: '/workspace/src/host.ts' },
      { runtime: null, draft: 'x', tab: draftPath }
    ])
  })

  it("re-keys the base's own entry persisted under the bare path of a runtime-owned draft", () => {
    const state = restore(
      session({
        openFilesByWorktree: {
          [WORKTREE_ID]: [
            file(SAME_PATH, { runtimeEnvironmentId: 'env-1', dirtyDraftContent: 'x' })
          ]
        },
        unifiedTabs: { [WORKTREE_ID]: [{ ...editorTab(SAME_PATH), customLabel: 'mine' }] }
      }),
      session({
        openFilesByWorktree: { [WORKTREE_ID]: [file(SAME_PATH)] },
        unifiedTabs: { [WORKTREE_ID]: [editorTab(SAME_PATH)] },
        tabGroups: { [WORKTREE_ID]: [group([SAME_PATH])] }
      })
    )

    const ownedId = buildOwnedEditorFileId(SAME_PATH, WORKTREE_ID, 'env-1')
    expect(visibleFiles(state).map((entry) => entry.tab)).toEqual([SAME_PATH, ownedId])
    expect(
      state.unifiedTabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === ownedId)?.customLabel
    ).toBe('mine')
  })
})
