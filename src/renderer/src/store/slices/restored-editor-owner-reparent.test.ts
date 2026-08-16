// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useAppStore } from '@/store'
import { buildEditorSessionData } from '@/lib/workspace-session'
import {
  createExternalWatchEventHandler,
  getEditorExternalWatchTargets,
  useEditorExternalWatch
} from '@/hooks/useEditorExternalWatch'
import {
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from '@/lib/editor-file-operation-owner'
import type { AppState } from '@/store/types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

const SOURCE = 'repo-a::/repo-a'
const TARGET = 'repo-b::/repo-b'
const FILE_PATH = '/repo-b/docs/readme.md'

function WatchProbe(): null {
  useEditorExternalWatch()
  return null
}

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
      mode: 'edit',
      pendingDiskBaselineVerification: true
    },
    { suppressActiveRuntimeFallback: true }
  )
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

  afterEach(() => vi.useRealTimers())

  it('atomically migrates ownership, ids, placement, views, previews, and provenance', () => {
    const oldId = openRestoredSource()
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
        expiresAt: Date.now() + 1_000,
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
      isDirty: true,
      pendingDiskBaselineVerification: true
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

  it('does not retarget an explorer reveal owned by another workspace', () => {
    const oldId = openRestoredSource()
    useAppStore.setState({
      pendingExplorerReveal: { worktreeId: 'other-workspace', filePath: FILE_PATH, requestId: 1 }
    })

    expect(reparent(oldId).ok).toBe(true)
    expect(useAppStore.getState().pendingExplorerReveal?.worktreeId).toBe('other-workspace')
  })

  it('commits active reparenting through the complete workspace activation projection', () => {
    const oldId = openRestoredSource()
    const refreshGitHubForWorktreeIfStale = vi.fn()
    useAppStore.setState({
      activeTabId: 'source-terminal',
      activeBrowserTabId: 'source-browser',
      activePendingCreationId: 'source-creation',
      rightSidebarExplorerView: 'files',
      rightSidebarExplorerViewByWorktree: { [TARGET]: 'search' },
      tabsByWorktree: {
        [SOURCE]: [
          {
            id: 'source-terminal',
            ptyId: null,
            worktreeId: SOURCE,
            title: 'Source terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            generation: 1
          }
        ],
        [TARGET]: [
          {
            id: 'target-terminal',
            ptyId: null,
            worktreeId: TARGET,
            title: 'Target terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            generation: 4
          }
        ]
      },
      activeTabIdByWorktree: {
        [SOURCE]: 'source-terminal',
        [TARGET]: 'target-terminal'
      },
      unifiedTabsByWorktree: {
        ...useAppStore.getState().unifiedTabsByWorktree,
        [TARGET]: [
          {
            id: 'target-terminal',
            entityId: 'target-terminal',
            groupId: 'target-group',
            worktreeId: TARGET,
            contentType: 'terminal',
            label: 'Target terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        ...useAppStore.getState().groupsByWorktree,
        [TARGET]: [
          {
            id: 'target-group',
            worktreeId: TARGET,
            activeTabId: 'target-terminal',
            tabOrder: ['target-terminal']
          }
        ]
      },
      layoutByWorktree: {
        ...useAppStore.getState().layoutByWorktree,
        [TARGET]: { type: 'leaf', groupId: 'target-group' }
      },
      activeGroupIdByWorktree: {
        ...useAppStore.getState().activeGroupIdByWorktree,
        [TARGET]: 'target-group'
      },
      browserTabsByWorktree: {
        [SOURCE]: [{ id: 'source-browser' }],
        [TARGET]: [{ id: 'target-browser' }]
      },
      activeBrowserTabIdByWorktree: {
        [SOURCE]: 'source-browser',
        [TARGET]: 'target-browser'
      },
      everActivatedWorktreeIds: new Set([SOURCE]),
      refreshGitHubForWorktreeIfStale
    } as unknown as Partial<AppState>)
    const targetSnapshots: AppState[] = []
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.activeWorktreeId === TARGET) {
        targetSnapshots.push(state)
      }
    })

    const result = reparent(oldId)
    unsubscribe()

    expect(result.ok).toBe(true)
    expect(targetSnapshots).toHaveLength(1)
    const activated = targetSnapshots[0]
    expect(activated).toMatchObject({
      activeWorktreeId: TARGET,
      activeRepoId: 'repo-b',
      activeWorkspaceExecutionHostId: 'local',
      activeTabId: 'target-terminal',
      activeBrowserTabId: 'target-browser',
      activePendingCreationId: null,
      rightSidebarExplorerView: 'search',
      activeTabType: 'editor'
    })
    expect(activated.activeFileId).toBe(result.ok ? result.fileId : null)
    expect(activated.everActivatedWorktreeIds).toEqual(new Set([SOURCE, TARGET]))
    expect(activated.tabsByWorktree[TARGET]?.[0]).toMatchObject({
      id: 'target-terminal',
      generation: 5
    })
    expect(refreshGitHubForWorktreeIfStale).toHaveBeenCalledOnce()
    expect(refreshGitHubForWorktreeIfStale).toHaveBeenCalledWith(TARGET)
  })

  it('repairs a duplicate migrated tab id held by a non-selected destination group', () => {
    const oldId = openRestoredSource()
    const movedTabId = useAppStore.getState().unifiedTabsByWorktree[SOURCE]![0]!.id
    const keptFileId = useAppStore.getState().openFile(
      {
        filePath: '/repo-b/docs/other.md',
        relativePath: 'docs/other.md',
        worktreeId: TARGET,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const keptTab = useAppStore
      .getState()
      .unifiedTabsByWorktree[TARGET]!.find((tab) => tab.entityId === keptFileId)!
    useAppStore.setState((state) => ({
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [TARGET]: [
          { ...keptTab, groupId: 'other-group' },
          // A stale duplicate carrying the id the source tab keeps through the move.
          { ...keptTab, id: movedTabId, groupId: 'other-group' }
        ]
      },
      groupsByWorktree: {
        ...state.groupsByWorktree,
        [TARGET]: [
          {
            id: 'target-group',
            worktreeId: TARGET,
            activeTabId: null,
            tabOrder: [],
            recentTabIds: []
          },
          {
            id: 'other-group',
            worktreeId: TARGET,
            activeTabId: movedTabId,
            tabOrder: [keptTab.id, movedTabId],
            recentTabIds: [keptTab.id, movedTabId]
          }
        ]
      },
      layoutByWorktree: {
        ...state.layoutByWorktree,
        [TARGET]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'target-group' },
          second: { type: 'leaf', groupId: 'other-group' }
        }
      },
      activeGroupIdByWorktree: { ...state.activeGroupIdByWorktree, [TARGET]: 'target-group' }
    }))

    expect(reparent(oldId).ok).toBe(true)

    const next = useAppStore.getState()
    const groups = next.groupsByWorktree[TARGET]!
    const otherGroup = groups.find((group) => group.id === 'other-group')!
    expect(otherGroup).toMatchObject({
      activeTabId: keptTab.id,
      tabOrder: [keptTab.id],
      recentTabIds: [keptTab.id]
    })
    expect(groups.find((group) => group.id === 'target-group')?.tabOrder).toContain(movedTabId)
    // The migrated id survives exactly once, in the group that now owns the tab.
    expect(next.unifiedTabsByWorktree[TARGET]!.filter((tab) => tab.id === movedTabId)).toHaveLength(
      1
    )
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

  it.each([false, true])('fails closed on a %s destination collision', (dirtyDestination) => {
    const sourceId = openRestoredSource()
    const destinationId = useAppStore.getState().openFile(
      {
        filePath: FILE_PATH,
        relativePath: 'docs/readme.md',
        worktreeId: TARGET,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    if (dirtyDestination) {
      useAppStore.getState().setEditorDraft(destinationId, 'destination draft')
      useAppStore.getState().markFileDirty(destinationId, true)
    }
    const before = useAppStore.getState().openFiles

    expect(reparent(sourceId)).toEqual({ ok: false, reason: 'collision' })
    expect(useAppStore.getState().openFiles.map((file) => file.id)).toEqual(
      before.map((file) => file.id)
    )
    expect(useAppStore.getState().openFiles.find((file) => file.id === sourceId)?.worktreeId).toBe(
      SOURCE
    )
  })

  it('leaves destination tabs and groups byte-identical when activation hits a collision', () => {
    const sourceId = openRestoredSource()
    const destinationId = useAppStore.getState().openFile(
      {
        filePath: FILE_PATH,
        relativePath: 'docs/readme.md',
        worktreeId: TARGET,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const destinationTab = useAppStore
      .getState()
      .unifiedTabsByWorktree[TARGET]?.find((tab) => tab.entityId === destinationId)
    expect(destinationTab).toBeDefined()
    const staleTab = {
      ...destinationTab!,
      id: 'stale-target-tab',
      entityId: 'stale-target-file'
    }
    useAppStore.setState((state) => ({
      activeWorktreeId: SOURCE,
      activeFileId: sourceId,
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [TARGET]: [...(state.unifiedTabsByWorktree[TARGET] ?? []), staleTab]
      },
      groupsByWorktree: {
        ...state.groupsByWorktree,
        [TARGET]: (state.groupsByWorktree[TARGET] ?? []).map((group) =>
          group.id === staleTab.groupId
            ? {
                ...group,
                activeTabId: staleTab.id,
                tabOrder: [...group.tabOrder, staleTab.id],
                recentTabIds: [...(group.recentTabIds ?? []), staleTab.id]
              }
            : group
        )
      }
    }))
    const state = useAppStore.getState()
    state.setRestoredEditorOwnerMigrationPending(sourceId, true)
    const before = useAppStore.getState()

    const result = before.reparentRestoredEditorFileOwner({
      fileId: sourceId,
      targetWorktreeId: TARGET,
      targetRelativePath: 'docs/readme.md',
      targetExecutionHostId: 'local',
      targetRuntimeEnvironmentId: null,
      targetOperationProvenance: captureEditorFileOperationProvenance(before, TARGET, null, true)
    })

    expect(result).toEqual({ ok: false, reason: 'collision' })
    const after = useAppStore.getState()
    expect(after.unifiedTabsByWorktree).toBe(before.unifiedTabsByWorktree)
    expect(after.groupsByWorktree).toBe(before.groupsByWorktree)
    expect(after.layoutByWorktree).toBe(before.layoutByWorktree)
    expect(after.activeGroupIdByWorktree).toBe(before.activeGroupIdByWorktree)
    expect(after.activeWorktreeId).toBe(SOURCE)
    expect(after.activeFileId).toBe(sourceId)
  })

  it('moves the watcher projection from source to destination without fanout', () => {
    const oldId = openRestoredSource()
    const before = getEditorExternalWatchTargets(useAppStore.getState())
    const result = reparent(oldId)
    expect(result.ok).toBe(true)
    const after = getEditorExternalWatchTargets(useAppStore.getState())

    expect(before.targets.map((target) => target.worktreeId)).toEqual([SOURCE])
    expect(after.targets).toEqual([
      {
        worktreeId: TARGET,
        worktreePath: '/repo-b',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('unsubscribes the source watch once and subscribes the destination once', async () => {
    const watchWorktree = vi.fn().mockResolvedValue(undefined)
    const unwatchWorktree = vi.fn().mockResolvedValue(undefined)
    const previousApi = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = {
      fs: {
        watchWorktree,
        unwatchWorktree,
        onFsChanged: vi.fn(() => vi.fn())
      }
    }
    const oldId = openRestoredSource()
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    await act(async () => root.render(createElement(WatchProbe)))
    await vi.waitFor(() => expect(watchWorktree).toHaveBeenCalledTimes(1))
    expect(watchWorktree).toHaveBeenLastCalledWith({
      worktreePath: '/repo-a',
      connectionId: undefined
    })

    await act(async () => {
      expect(reparent(oldId).ok).toBe(true)
    })
    await vi.waitFor(() => {
      expect(unwatchWorktree).toHaveBeenCalledTimes(1)
      expect(watchWorktree).toHaveBeenCalledTimes(2)
    })
    expect(unwatchWorktree).toHaveBeenLastCalledWith({
      worktreePath: '/repo-a',
      connectionId: undefined
    })
    expect(watchWorktree).toHaveBeenLastCalledWith({
      worktreePath: '/repo-b',
      connectionId: undefined
    })

    await act(async () => root.unmount())
    container.remove()
    ;(window as unknown as { api?: unknown }).api = previousApi
  })

  it('reparents into a folder workspace with local save and watch authority', () => {
    useAppStore.setState({
      folderWorkspaces: [
        {
          id: 'notes',
          projectGroupId: 'group-notes',
          folderPath: '/notes',
          connectionId: null,
          executionHostId: 'local'
        }
      ],
      projectGroups: [{ id: 'group-notes', name: 'Notes', executionHostId: 'local' }]
    } as unknown as Partial<AppState>)
    const oldId = useAppStore.getState().openFile(
      {
        filePath: '/notes/todo.md',
        relativePath: '/notes/todo.md',
        worktreeId: SOURCE,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    useAppStore.getState().setRestoredEditorOwnerMigrationPending(oldId, true)
    const result = useAppStore.getState().reparentRestoredEditorFileOwner({
      fileId: oldId,
      targetWorktreeId: 'folder:notes',
      targetRelativePath: 'todo.md',
      targetExecutionHostId: 'local',
      targetRuntimeEnvironmentId: null,
      targetOperationProvenance: captureEditorFileOperationProvenance(
        useAppStore.getState(),
        'folder:notes',
        null,
        true
      )
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const state = useAppStore.getState()
    const moved = state.openFiles.find((file) => file.id === result.fileId)!
    expect(getEditorFileOperationContext(state, moved, null)).toMatchObject({
      worktreeId: 'folder:notes',
      worktreePath: '/notes',
      expectedExecutionHostId: 'local'
    })
    expect(getEditorExternalWatchTargets(state).targets).toEqual([
      {
        worktreeId: 'folder:notes',
        worktreePath: '/notes',
        connectionId: undefined,
        runtimeEnvironmentId: null
      }
    ])
  })

  it('captures exact direct-SSH host and connection-generation authority', () => {
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) => ({
        ...repo,
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1'
      })),
      worktreesByRepo: Object.fromEntries(
        Object.entries(state.worktreesByRepo).map(([repoId, worktrees]) => [
          repoId,
          worktrees.map((worktree) => ({ ...worktree, hostId: 'ssh:ssh-1' as const }))
        ])
      ),
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected' as const,
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 7
          }
        ]
      ])
    }))
    const oldId = openRestoredSource()
    useAppStore.getState().setRestoredEditorOwnerMigrationPending(oldId, true)
    const result = useAppStore.getState().reparentRestoredEditorFileOwner({
      fileId: oldId,
      targetWorktreeId: TARGET,
      targetRelativePath: 'docs/readme.md',
      targetExecutionHostId: 'ssh:ssh-1',
      targetRuntimeEnvironmentId: null,
      targetOperationProvenance: captureEditorFileOperationProvenance(
        useAppStore.getState(),
        TARGET,
        null,
        true
      )
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(
      useAppStore.getState().openFiles.find((file) => file.id === result.fileId)
    ).toMatchObject({
      externalSshTargetId: 'ssh-1',
      operationProvenance: {
        expectedSshConnectionGeneration: 7,
        generation: {
          route: { executionHostId: 'ssh:ssh-1', runtimeEnvironmentId: null }
        }
      }
    })
  })

  it('correlates destination change, delete, and rename events after reparent', () => {
    vi.useFakeTimers()
    const oldId = openRestoredSource()
    const result = reparent(oldId)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const target = {
      worktreeId: TARGET,
      worktreePath: '/repo-b',
      connectionId: undefined,
      runtimeEnvironmentId: null
    }
    const externalChanges: unknown[] = []
    const listener = (event: Event): void => {
      externalChanges.push((event as CustomEvent).detail)
    }
    window.addEventListener('orca:editor-external-file-change', listener)
    const watcher = createExternalWatchEventHandler((path, owner) =>
      path === target.worktreePath && owner === null ? target : undefined
    )

    watcher.handleFsChanged({
      worktreePath: '/repo-b',
      events: [{ kind: 'update', absolutePath: FILE_PATH }]
    })
    vi.advanceTimersByTime(100)
    expect(externalChanges).toContainEqual({
      worktreeId: TARGET,
      worktreePath: '/repo-b',
      relativePath: 'docs/readme.md',
      runtimeEnvironmentId: null
    })

    watcher.handleFsChanged({
      worktreePath: '/repo-b',
      events: [{ kind: 'delete', absolutePath: FILE_PATH }]
    })
    vi.advanceTimersByTime(100)
    expect(
      useAppStore.getState().openFiles.find((file) => file.id === result.fileId)?.externalMutation
    ).toBe('deleted')
    useAppStore.getState().setExternalMutation(result.fileId, null)

    watcher.handleFsChanged({
      worktreePath: '/repo-b',
      events: [
        { kind: 'delete', absolutePath: FILE_PATH },
        { kind: 'create', absolutePath: '/repo-b/archive/readme.md' }
      ]
    })
    expect(
      useAppStore.getState().openFiles.find((file) => file.id === result.fileId)?.externalMutation
    ).toBe('renamed')

    watcher.dispose()
    window.removeEventListener('orca:editor-external-file-change', listener)
    vi.useRealTimers()
  })
})
