// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { buildEditorSessionData } from '@/lib/workspace/persistence/workspace-session'
import '@/hooks/editor-external-watch-targets'
import { captureEditorFileOperationProvenance } from '@/lib/editor/file-operations/editor-file-operation-provenance'
import { getEditorFileOperationContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import type { AppState } from '@/store/types'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session/workspace-session-state-types'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../tabs/tabs-drawn-from-main.test-fixture'
import '../../../../../../shared/layout-owner-switch'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const SOURCE = 'repo-a::/repo-a'
const TARGET = 'repo-b::/repo-b'
const FILE_PATH = '/repo-b/docs/readme.md'

function installWorkspaceState(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: SOURCE,
    settings: { editorAutoSave: false },
    repos: [
      { id: 'repo-a', path: '/repo-a', kind: 'git', executionHostId: 'local' },
      { id: 'repo-b', path: '/repo-b', kind: 'git', executionHostId: 'local' }
    ],
    worktreesByRepo: {
      'repo-a': [{ id: SOURCE, repoId: 'repo-a', path: '/repo-a', hostId: 'local', branch: '' }],
      'repo-b': [{ id: TARGET, repoId: 'repo-b', path: '/repo-b', hostId: 'local', branch: '' }]
    },
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    folderWorkspaces: [],
    projectGroups: [],
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    gitStatusHugeByWorktree: {}
  } as unknown as Partial<AppState>)
}

function openRestoredSource(): string {
  return useAppStore.getState().openFile(
    {
      filePath: FILE_PATH,
      relativePath: FILE_PATH,
      worktreeId: SOURCE,
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

let main: TabsDrawnFromMain = { settle: async () => {}, close: () => {} }

/** The restored tab, drawn: a layout-owner build draws it from main's frame. */
async function openDrawnRestoredSource(): Promise<string> {
  main = await drawTabsFromMain(useAppStore)
  const fileId = openRestoredSource()
  await main.settle()
  return fileId
}

function reparent(fileId: string) {
  const state = useAppStore.getState()
  state.setRestoredEditorOwnerMigrationPending(fileId, true)
  return state.reparentRestoredEditorFileOwner({
    fileId,
    targetWorktreeId: TARGET,
    targetRelativePath: 'docs/readme.md',
    targetExecutionHostId: 'local',
    targetRuntimeEnvironmentId: null,
    targetOperationProvenance: captureEditorFileOperationProvenance(state, TARGET, null, true)
  })
}

describe('restored editor owner reparent', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    installWorkspaceState()
  })

  afterEach(() => {
    vi.useRealTimers()
    main.close()
    main = { settle: async () => {}, close: () => {} }
  })

  it('atomically migrates ownership, ids, placement, views, previews, and provenance', async () => {
    const oldId = await openDrawnRestoredSource()
    const state = useAppStore.getState()
    state.setEditorDraft(oldId, 'edited draft')
    state.markFileDirty(oldId, true)
    state.setEditorCursorLine(oldId, 37)
    state.setMarkdownViewMode(oldId, 'rich')
    state.setEditorViewMode(oldId, 'changes')
    state.setMarkdownFrontmatterVisible(oldId, false)
    state.setMarkdownTableOfContentsVisible(oldId, true)
    useAppStore.setState((current) => ({
      pendingEditorReveal: {
        fileId: oldId,
        filePath: FILE_PATH,
        line: 4,
        column: 2,
        matchLength: 0
      },
      pendingEditorFocusRequest: {
        fileId: oldId,
        worktreeId: SOURCE,
        viewStateId: 'view-1',
        expiresAt: Number.MAX_SAFE_INTEGER,
        token: 1
      },
      pendingExplorerReveal: { worktreeId: SOURCE, filePath: FILE_PATH, requestId: 1 },
      openFiles: [
        ...current.openFiles,
        {
          ...current.openFiles[0],
          id: 'preview-1',
          mode: 'markdown-preview' as const,
          markdownPreviewSourceFileId: oldId,
          isDirty: false
        }
      ]
    }))

    const result = reparent(oldId)
    await main.settle()

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const next = useAppStore.getState()
    const moved = next.openFiles.find((file) => file.id === result.fileId)!
    expect(moved).toMatchObject({
      filePath: FILE_PATH,
      relativePath: 'docs/readme.md',
      worktreeId: TARGET,
      runtimeEnvironmentId: null,
      isDirty: true
    })
    expect(moved.pendingOwnerMigration).toBeUndefined()
    expect(moved.operationProvenance?.generation.route).toEqual({
      executionHostId: 'local',
      runtimeEnvironmentId: null
    })
    expect(getEditorFileOperationContext(next, moved, '/repo-b').worktreeId).toBe(TARGET)
    expect(next.editorDrafts).toEqual({ [result.fileId]: 'edited draft' })
    expect(next.editorCursorLine[result.fileId]).toBe(37)
    expect(next.markdownViewMode[result.fileId]).toBe('rich')
    expect(next.editorViewMode[result.fileId]).toBe('changes')
    expect(next.markdownFrontmatterVisible[result.fileId]).toBe(false)
    expect(next.markdownTableOfContentsVisible[result.fileId]).toBe(true)
    expect(next.openFiles.find((file) => file.mode === 'markdown-preview')).toMatchObject({
      id: `markdown-preview::${result.fileId}`,
      markdownPreviewSourceFileId: result.fileId,
      worktreeId: TARGET,
      relativePath: 'docs/readme.md'
    })
    expect(next.unifiedTabsByWorktree[SOURCE]).toEqual([])
    const movedTabId = next.unifiedTabsByWorktree[TARGET]?.[0]?.id
    expect(next.unifiedTabsByWorktree[TARGET]?.[0]?.entityId).toBe(result.fileId)
    expect(next.groupsByWorktree[TARGET]?.[0]).toMatchObject({
      activeTabId: movedTabId,
      tabOrder: [movedTabId]
    })
    expect(next.tabBarOrderByWorktree[TARGET]).toEqual([result.fileId])
    expect(next.activeFileIdByWorktree[SOURCE]).toBeNull()
    expect(next.activeFileIdByWorktree[TARGET]).toBe(result.fileId)
    expect(next.activeWorktreeId).toBe(TARGET)
    expect(next.activeWorkspaceExecutionHostId).toBe('local')
    expect(next.activeRepoId).toBe('repo-b')
    expect(next.activeGroupIdByWorktree[SOURCE]).toBeUndefined()
    expect(next.pendingEditorReveal?.fileId).toBe(result.fileId)
    expect(next.pendingEditorFocusRequest).toMatchObject({
      fileId: result.fileId,
      worktreeId: TARGET
    })
    expect(next.pendingExplorerReveal?.worktreeId).toBe(TARGET)
  })

  it('persists and restores the destination owner and dirty hot-exit draft', () => {
    const oldId = openRestoredSource()
    useAppStore.getState().setEditorDraft(oldId, 'hot exit')
    useAppStore.getState().markFileDirty(oldId, true)
    const result = reparent(oldId)
    expect(result.ok).toBe(true)

    const state = useAppStore.getState()
    const session = buildEditorSessionData(
      state.openFiles,
      state.editorDrafts,
      state.markdownFrontmatterVisible,
      state.activeFileIdByWorktree,
      state.activeTabTypeByWorktree
    )
    expect(session.openFilesByWorktree?.[SOURCE]).toBeUndefined()
    expect(session.openFilesByWorktree?.[TARGET]?.[0]).toMatchObject({
      relativePath: 'docs/readme.md',
      dirtyDraftContent: 'hot exit'
    })

    installWorkspaceState()
    useAppStore.getState().hydrateEditorSession(session as WorkspaceSessionState)
    const restored = useAppStore.getState().openFiles[0]
    expect(restored).toMatchObject({
      worktreeId: TARGET,
      relativePath: 'docs/readme.md',
      isDirty: true
    })
    expect(useAppStore.getState().editorDrafts[restored.id]).toBe('hot exit')
  })
})
