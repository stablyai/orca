import type { StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import type { AppState } from '../types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { OpenFile } from './editor'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

const WORKTREE_ID = 'wt-1'
const FILE_PATH = '/repo/app.ts'
const GROUP_ID = 'group-1'

function openFile(id: string, overrides: Partial<OpenFile> = {}): OpenFile {
  const base: OpenFile = {
    id,
    filePath: FILE_PATH,
    relativePath: 'app.ts',
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    isPreview: false,
    runtimeEnvironmentId: null
  }
  return { ...base, ...overrides }
}

function editorTab(id: string, entityId: string, groupId = GROUP_ID): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label: 'app.ts',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function group(id: string, tabIds: string[]): TabGroup {
  return {
    id,
    worktreeId: WORKTREE_ID,
    activeTabId: tabIds[0] ?? null,
    tabOrder: tabIds,
    recentTabIds: tabIds.toReversed()
  }
}

function seed(store: StoreApi<AppState>, openFiles: OpenFile[], tabs: Tab[], groups: TabGroup[]) {
  store.setState({
    openFiles,
    activeFileId: openFiles[0]?.id ?? null,
    activeFileIdByWorktree: { [WORKTREE_ID]: openFiles[0]?.id ?? null },
    unifiedTabsByWorktree: { [WORKTREE_ID]: tabs },
    groupsByWorktree: { [WORKTREE_ID]: groups },
    activeGroupIdByWorktree: { [WORKTREE_ID]: groups[0]?.id ?? GROUP_ID },
    layoutByWorktree: {
      [WORKTREE_ID]: { type: 'leaf' as const, groupId: groups[0]?.id ?? GROUP_ID }
    },
    tabBarOrderByWorktree: { [WORKTREE_ID]: openFiles.map((file) => file.id) }
  })
}

describe('closeFile duplicate-record sweep', () => {
  it('closes every duplicate record of the document and all of their tabs', () => {
    const store = createEditorTabsStore()
    const ids = [FILE_PATH, 'editor:dup-a', 'editor:dup-b']
    seed(
      store,
      ids.map((id) => openFile(id)),
      ids.map((id) => editorTab(`tab:${id}`, id)),
      [
        group(
          GROUP_ID,
          ids.map((id) => `tab:${id}`)
        )
      ]
    )

    store.getState().closeFile('editor:dup-a')

    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    const remainingGroup = store.getState().groupsByWorktree[WORKTREE_ID]?.[0]
    expect(remainingGroup?.tabOrder ?? []).toEqual([])
    expect(remainingGroup?.recentTabIds ?? []).toEqual([])
    expect(store.getState().tabBarOrderByWorktree[WORKTREE_ID]).toEqual([])
    expect(store.getState().activeFileIdByWorktree[WORKTREE_ID]).toBeNull()
  })

  it('pushes exactly one reopen snapshot for the swept document', () => {
    const store = createEditorTabsStore()
    const ids = [FILE_PATH, 'editor:dup-a', 'editor:dup-b']
    seed(
      store,
      ids.map((id) => openFile(id)),
      ids.map((id) => editorTab(`tab:${id}`, id)),
      [
        group(
          GROUP_ID,
          ids.map((id) => `tab:${id}`)
        )
      ]
    )

    store.getState().closeFile(FILE_PATH)

    expect(store.getState().recentlyClosedEditorTabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(store.getState().recentlyClosedTabKindsByWorktree[WORKTREE_ID]).toEqual(['editor'])
    expect(store.getState().reopenClosedEditorTab(WORKTREE_ID)).toBe(true)
    expect(store.getState().openFiles).toHaveLength(1)
    // Why: three tab closes must not leave two more reopen presses backed by nothing.
    expect(store.getState().reopenClosedEditorTab(WORKTREE_ID)).toBe(false)
  })

  it('tells the host about a mirrored duplicate swept under another id', () => {
    const store = createEditorTabsStore()
    notifyHostOfMirroredEditorCloseMock.mockClear()
    const files = [
      openFile(FILE_PATH),
      openFile('editor:mirrored', { mirroredFromRuntimeSession: true })
    ]
    seed(
      store,
      files,
      files.map((file) => editorTab(`tab:${file.id}`, file.id)),
      [
        group(
          GROUP_ID,
          files.map((file) => `tab:${file.id}`)
        )
      ]
    )

    store.getState().closeFile(FILE_PATH)

    expect(notifyHostOfMirroredEditorCloseMock).toHaveBeenCalledWith(
      expect.anything(),
      WORKTREE_ID,
      'editor:mirrored'
    )
  })

  it('keeps a duplicate that holds unsaved work instead of discarding it', () => {
    const store = createEditorTabsStore()
    const files = [openFile(FILE_PATH), openFile('editor:dirty', { isDirty: true })]
    seed(
      store,
      files,
      files.map((file) => editorTab(`tab:${file.id}`, file.id)),
      [
        group(
          GROUP_ID,
          files.map((file) => `tab:${file.id}`)
        )
      ]
    )
    store.setState({ editorDrafts: { 'editor:dirty': 'unsaved text' } })

    store.getState().closeFile(FILE_PATH)

    // The save/discard prompt only asked about the named id, so the rival buffer stays open.
    expect(store.getState().openFiles.map((file) => file.id)).toEqual(['editor:dirty'])
    expect(store.getState().editorDrafts['editor:dirty']).toBe('unsaved text')
    expect(
      (store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.entityId)
    ).toEqual(['editor:dirty'])
  })

  it('never sweeps another diff variant of the same path', () => {
    const store = createEditorTabsStore()
    const files = [
      openFile('diff:unstaged', { mode: 'diff', diffSource: 'unstaged' }),
      openFile('diff:staged', { mode: 'diff', diffSource: 'staged' }),
      openFile('diff:combined-all', { mode: 'diff', diffSource: 'combined-all' }),
      openFile('diff:combined-branch', { mode: 'diff', diffSource: 'combined-branch' })
    ]
    seed(
      store,
      files,
      files.map((file) => editorTab(`tab:${file.id}`, file.id)),
      [
        group(
          GROUP_ID,
          files.map((file) => `tab:${file.id}`)
        )
      ]
    )

    store.getState().closeFile('diff:unstaged')
    store.getState().closeFile('diff:combined-all')

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([
      'diff:staged',
      'diff:combined-branch'
    ])
  })

  it('leaves the same path open under a different owner or mode', () => {
    const store = createEditorTabsStore()
    const files = [
      openFile(FILE_PATH),
      openFile('editor:runtime', { runtimeEnvironmentId: 'env-a' }),
      openFile('editor:ssh', { externalSshTargetId: 'ssh-target' }),
      openFile('editor:diff', { mode: 'diff' })
    ]
    seed(
      store,
      files,
      files.map((file) => editorTab(`tab:${file.id}`, file.id)),
      [
        group(
          GROUP_ID,
          files.map((file) => `tab:${file.id}`)
        )
      ]
    )

    store.getState().closeFile(FILE_PATH)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([
      'editor:runtime',
      'editor:ssh',
      'editor:diff'
    ])
  })

  it('refuses to reselect a swept document', () => {
    const store = createEditorTabsStore()
    const ids = [FILE_PATH, 'editor:dup-a']
    seed(
      store,
      ids.map((id) => openFile(id)),
      ids.map((id) => editorTab(`tab:${id}`, id)),
      [
        group(
          GROUP_ID,
          ids.map((id) => `tab:${id}`)
        )
      ]
    )

    store.getState().closeFile(FILE_PATH)
    store.getState().setActiveFile('editor:dup-a')

    expect(store.getState().activeFileId).toBeNull()
    expect(store.getState().activeFileIdByWorktree[WORKTREE_ID]).toBeNull()

    // Same guard for an id the store never knew.
    store.getState().setActiveFile('/repo/never-opened.ts')

    expect(store.getState().activeFileId).toBeNull()
  })

  it('keeps a split view intact until the document itself closes', () => {
    const store = createEditorTabsStore()
    seed(
      store,
      [openFile(FILE_PATH)],
      [
        editorTab('tab:left', FILE_PATH, 'group-left'),
        editorTab('tab:right', FILE_PATH, 'group-right')
      ],
      [group('group-left', ['tab:left']), group('group-right', ['tab:right'])]
    )

    store.getState().closeUnifiedTab('tab:left')

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([FILE_PATH])

    store.getState().closeFile(FILE_PATH)

    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
  })

  it('leaves another worktree whose tab reuses the closed file id untouched', () => {
    const store = createEditorTabsStore()
    const otherWorktreeId = 'wt-2'
    const otherGroupId = 'group-2'
    seed(
      store,
      [openFile(FILE_PATH)],
      [editorTab(`tab:${FILE_PATH}`, FILE_PATH)],
      [group(GROUP_ID, [`tab:${FILE_PATH}`])]
    )
    store.setState({
      unifiedTabsByWorktree: {
        ...store.getState().unifiedTabsByWorktree,
        // Why the shared entity id: an unoccupied editor id is just the file path, so two workspaces
        // can name the same tab entity — the scan must not reach across on that coincidence.
        [otherWorktreeId]: [
          {
            ...editorTab('tab:wt-2', FILE_PATH, otherGroupId),
            worktreeId: otherWorktreeId
          }
        ]
      },
      groupsByWorktree: {
        ...store.getState().groupsByWorktree,
        [otherWorktreeId]: [
          {
            id: otherGroupId,
            worktreeId: otherWorktreeId,
            activeTabId: 'tab:wt-2',
            tabOrder: ['tab:wt-2'],
            recentTabIds: ['tab:wt-2']
          }
        ]
      },
      layoutByWorktree: {
        ...store.getState().layoutByWorktree,
        [otherWorktreeId]: { type: 'leaf' as const, groupId: otherGroupId }
      }
    })
    const otherTabsBefore = store.getState().unifiedTabsByWorktree[otherWorktreeId]

    store.getState().closeFile(FILE_PATH)

    expect(store.getState().unifiedTabsByWorktree[otherWorktreeId]).toBe(otherTabsBefore)
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
  })

  it('selects the closed file`s neighbour instead of skipping past the swept siblings', () => {
    const store = createEditorTabsStore()
    const files = [
      openFile('editor:x', { filePath: '/repo/x.ts', relativePath: 'x.ts' }),
      openFile('editor:dup-a'),
      openFile('editor:dup-b'),
      openFile('editor:y', { filePath: '/repo/y.ts', relativePath: 'y.ts' }),
      openFile('editor:z', { filePath: '/repo/z.ts', relativePath: 'z.ts' })
    ]
    // Why no tab model: with one hydrated, the unified close path re-derives the selection from the
    // group's active tab and closeFile's own reselect never shows.
    store.setState({
      openFiles: files,
      activeFileId: 'editor:dup-b',
      activeFileIdByWorktree: { [WORKTREE_ID]: 'editor:dup-b' },
      tabBarOrderByWorktree: { [WORKTREE_ID]: files.map((file) => file.id) }
    })

    store.getState().closeFile('editor:dup-b')

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([
      'editor:x',
      'editor:y',
      'editor:z'
    ])
    // dup-a is swept with dup-b, so the survivor that took their place is y — not z.
    expect(store.getState().activeFileIdByWorktree[WORKTREE_ID]).toBe('editor:y')
    expect(store.getState().activeFileId).toBe('editor:y')
  })

  it('never sweeps a read-only live-tail log along with the writable tab for its path', () => {
    const store = createEditorTabsStore()
    const logId = 'editor:log'
    seed(
      store,
      [openFile(FILE_PATH), openFile(logId, { readOnly: true, liveTail: true })],
      [editorTab(`tab:${FILE_PATH}`, FILE_PATH), editorTab(`tab:${logId}`, logId)],
      [group(GROUP_ID, [`tab:${FILE_PATH}`, `tab:${logId}`])]
    )

    store.getState().closeFile(FILE_PATH)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([logId])
    expect(
      (store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.entityId)
    ).toEqual([logId])
  })

  it('never sweeps the writable tab along with the read-only log for its path', () => {
    const store = createEditorTabsStore()
    const logId = 'editor:log'
    seed(
      store,
      [openFile(FILE_PATH), openFile(logId, { readOnly: true, liveTail: true })],
      [editorTab(`tab:${FILE_PATH}`, FILE_PATH), editorTab(`tab:${logId}`, logId)],
      [group(GROUP_ID, [`tab:${FILE_PATH}`, `tab:${logId}`])]
    )

    store.getState().closeFile(logId)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([FILE_PATH])
    expect(
      (store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.entityId)
    ).toEqual([FILE_PATH])
  })

  it('keeps a clean duplicate whose tab is pinned', () => {
    const store = createEditorTabsStore()
    const pinnedId = 'editor:dup-pinned'
    seed(
      store,
      [openFile(FILE_PATH), openFile(pinnedId)],
      [
        editorTab(`tab:${FILE_PATH}`, FILE_PATH),
        { ...editorTab(`tab:${pinnedId}`, pinnedId), isPinned: true }
      ],
      [group(GROUP_ID, [`tab:${FILE_PATH}`, `tab:${pinnedId}`])]
    )

    store.getState().closeFile(FILE_PATH)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([pinnedId])
    expect(
      (store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.entityId)
    ).toEqual([pinnedId])
  })

  it('sweeps the same clean duplicate once its tab is unpinned', () => {
    const store = createEditorTabsStore()
    const siblingId = 'editor:dup-pinned'
    seed(
      store,
      [openFile(FILE_PATH), openFile(siblingId)],
      [editorTab(`tab:${FILE_PATH}`, FILE_PATH), editorTab(`tab:${siblingId}`, siblingId)],
      [group(GROUP_ID, [`tab:${FILE_PATH}`, `tab:${siblingId}`])]
    )

    store.getState().closeFile(FILE_PATH)

    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
  })

  it('still closes the named record when its own tab is pinned', () => {
    const store = createEditorTabsStore()
    const siblingId = 'editor:dup-pinned'
    seed(
      store,
      [openFile(FILE_PATH), openFile(siblingId)],
      [
        { ...editorTab(`tab:${FILE_PATH}`, FILE_PATH), isPinned: true },
        { ...editorTab(`tab:${siblingId}`, siblingId), isPinned: true }
      ],
      [group(GROUP_ID, [`tab:${FILE_PATH}`, `tab:${siblingId}`])]
    )

    store.getState().closeFile(FILE_PATH)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([siblingId])
    expect(
      (store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.entityId)
    ).toEqual([siblingId])
  })
})
