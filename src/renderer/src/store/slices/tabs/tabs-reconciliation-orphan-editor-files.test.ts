import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { Tab } from '../../../../../shared/tab-types'
import type { OpenFile } from '../editor'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'
import { createTestStore } from '../store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createTabsSliceMockApi()

const WORKTREE_ID = 'repo-1::/workspace'
const GROUP_ID = 'group-1'
const OTHER_WORKTREE_ID = 'repo-2::/other-workspace'
const OTHER_GROUP_ID = 'group-2'
const TABBED_FILE_ID = '/workspace/tabbed.ts'
const ORPHAN_FILE_ID = '/workspace/orphan.ts'

function openFile(id: string, overrides: Partial<OpenFile> = {}): OpenFile {
  const base: OpenFile = {
    id,
    filePath: id,
    relativePath: id.slice('/workspace/'.length),
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    isPreview: false
  }
  return { ...base, ...overrides }
}

function editorTab(entityId: string): Tab {
  return {
    id: `tab:${entityId}`,
    entityId,
    groupId: GROUP_ID,
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function prepareStore(openFiles: OpenFile[], activeFileId: string | null) {
  const store = createTestStore()
  store.setState({
    openFiles,
    activeFileIdByWorktree: { [WORKTREE_ID]: activeFileId },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [editorTab(TABBED_FILE_ID)] },
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: GROUP_ID,
          worktreeId: WORKTREE_ID,
          activeTabId: `tab:${TABBED_FILE_ID}`,
          tabOrder: [`tab:${TABBED_FILE_ID}`],
          recentTabIds: [`tab:${TABBED_FILE_ID}`]
        }
      ]
    },
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
    layoutByWorktree: { [WORKTREE_ID]: { type: 'leaf' as const, groupId: GROUP_ID } }
  })
  return store
}

describe('hydrated reconciliation orphan editor sweep', () => {
  it('drops an open document no tab references', () => {
    const store = prepareStore([openFile(TABBED_FILE_ID), openFile(ORPHAN_FILE_ID)], TABBED_FILE_ID)

    store.getState().reconcileWorktreeTabModels([WORKTREE_ID])

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([TABBED_FILE_ID])
  })

  it('keeps the workspace active document even when it lost its tab', () => {
    const store = prepareStore([openFile(TABBED_FILE_ID), openFile(ORPHAN_FILE_ID)], ORPHAN_FILE_ID)

    store.getState().reconcileWorktreeTabModels([WORKTREE_ID])

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([
      TABBED_FILE_ID,
      ORPHAN_FILE_ID
    ])
  })

  it('keeps an orphan that still holds an unsaved buffer', () => {
    const store = prepareStore(
      [openFile(TABBED_FILE_ID), openFile(ORPHAN_FILE_ID, { isDirty: true })],
      TABBED_FILE_ID
    )

    store.getState().reconcileWorktreeTabModels([WORKTREE_ID])

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([
      TABBED_FILE_ID,
      ORPHAN_FILE_ID
    ])
  })

  it('keeps an orphan whose unsaved draft has not flushed into isDirty yet', () => {
    const store = prepareStore([openFile(TABBED_FILE_ID), openFile(ORPHAN_FILE_ID)], TABBED_FILE_ID)
    store.setState({ editorDrafts: { [ORPHAN_FILE_ID]: 'typed but not flushed' } })

    store.getState().reconcileWorktreeTabModels([WORKTREE_ID])

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([
      TABBED_FILE_ID,
      ORPHAN_FILE_ID
    ])
  })

  it('drops a swept document from the tab strip order', () => {
    const store = prepareStore([openFile(TABBED_FILE_ID), openFile(ORPHAN_FILE_ID)], TABBED_FILE_ID)
    store.setState({
      tabBarOrderByWorktree: { [WORKTREE_ID]: [TABBED_FILE_ID, ORPHAN_FILE_ID] }
    })

    store.getState().reconcileWorktreeTabModels([WORKTREE_ID])

    expect(store.getState().tabBarOrderByWorktree[WORKTREE_ID]).toEqual([TABBED_FILE_ID])
  })

  it('leaves openFiles identical when nothing is orphaned', () => {
    const store = prepareStore([openFile(TABBED_FILE_ID)], TABBED_FILE_ID)
    const before = store.getState().openFiles

    store.getState().reconcileWorktreeTabModels([WORKTREE_ID])

    expect(store.getState().openFiles).toBe(before)
  })

  it('never sweeps a workspace whose tab model was never hydrated', () => {
    const store = prepareStore([openFile(TABBED_FILE_ID), openFile(ORPHAN_FILE_ID)], TABBED_FILE_ID)
    store.setState({ unifiedTabsByWorktree: {} })

    store.getState().reconcileWorktreeTabModels([WORKTREE_ID])

    expect(store.getState().openFiles).toHaveLength(2)
  })

  it('leaves the same id alone in a workspace that still renders it', () => {
    // Why the shared id: an unowned editor id is the bare file path, so one id names a live
    // document in the other workspace while it is orphaned here.
    const store = prepareStore([openFile(TABBED_FILE_ID), openFile(ORPHAN_FILE_ID)], TABBED_FILE_ID)
    store.setState({
      openFiles: [
        openFile(TABBED_FILE_ID),
        openFile(ORPHAN_FILE_ID),
        openFile(ORPHAN_FILE_ID, { worktreeId: OTHER_WORKTREE_ID })
      ],
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [editorTab(TABBED_FILE_ID)],
        [OTHER_WORKTREE_ID]: [
          { ...editorTab(ORPHAN_FILE_ID), worktreeId: OTHER_WORKTREE_ID, groupId: OTHER_GROUP_ID }
        ]
      },
      groupsByWorktree: {
        ...store.getState().groupsByWorktree,
        [OTHER_WORKTREE_ID]: [
          {
            id: OTHER_GROUP_ID,
            worktreeId: OTHER_WORKTREE_ID,
            activeTabId: `tab:${ORPHAN_FILE_ID}`,
            tabOrder: [`tab:${ORPHAN_FILE_ID}`],
            recentTabIds: [`tab:${ORPHAN_FILE_ID}`]
          }
        ]
      },
      activeGroupIdByWorktree: {
        ...store.getState().activeGroupIdByWorktree,
        [OTHER_WORKTREE_ID]: OTHER_GROUP_ID
      },
      layoutByWorktree: {
        ...store.getState().layoutByWorktree,
        [OTHER_WORKTREE_ID]: { type: 'leaf' as const, groupId: OTHER_GROUP_ID }
      },
      tabBarOrderByWorktree: {
        [WORKTREE_ID]: [TABBED_FILE_ID, ORPHAN_FILE_ID],
        [OTHER_WORKTREE_ID]: [ORPHAN_FILE_ID]
      }
    })

    store.getState().reconcileWorktreeTabModels([WORKTREE_ID, OTHER_WORKTREE_ID])

    expect(store.getState().openFiles.map((file) => [file.worktreeId, file.id])).toEqual([
      [WORKTREE_ID, TABBED_FILE_ID],
      [OTHER_WORKTREE_ID, ORPHAN_FILE_ID]
    ])
    expect(store.getState().tabBarOrderByWorktree[OTHER_WORKTREE_ID]).toEqual([ORPHAN_FILE_ID])
  })

  it('sweeps a workspace whose hydrated tab list is present but empty', () => {
    const store = prepareStore([openFile(TABBED_FILE_ID), openFile(ORPHAN_FILE_ID)], TABBED_FILE_ID)
    // Why empty rather than absent: the tab model is known and renders no editor, so both documents
    // are unreachable — only the workspace's active file is held back by the selection guard.
    store.setState({ unifiedTabsByWorktree: { [WORKTREE_ID]: [] } })

    store.getState().reconcileWorktreeTabModels([WORKTREE_ID])

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([TABBED_FILE_ID])
  })
})
