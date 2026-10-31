import { useAppStore } from '@/store'
import type * as AppStoreModule from '../index'
// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import type { StoreApi } from 'zustand'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { seed, seedEditors, O, D, C1 } from './workspace-presentation-test-fixture'
import { makeOpenFile, makeUnifiedTab, makeWorktree } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { rawWorkspaceState } from '../workspace-source-state'
import { workspaceAdmittedFiles } from '../workspace-admitted-files'
import { useMarkdownDocuments } from '../../components/editor/useMarkdownDocuments'
import { useAiVaultSessionDisplayTitle } from '../../components/right-sidebar/use-ai-vault-session-display-title'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { useWorktreeFiles } from '../../components/terminal/use-worktree-files'
import { closeTerminalTabsToRight } from '../../components/terminal/terminal-tab-bulk-actions'
import { deriveActiveSurfaceForWorktree } from './tabs/tabs-surface'
import { buildRecentTabSwitcherModel } from '../../components/tab-bar/recent-tab-switching'
import { useTerminalEditorCloseFoundation } from '../../components/use-terminal-editor-close-foundation'
import { useTerminalEditorCloseQueue } from '../../components/use-terminal-editor-close-queue'
import { useTerminalEditorCloseDialogActions } from '../../components/use-terminal-editor-close-dialog-actions'
import { useTerminalBulkCloseActions } from '../../components/use-terminal-bulk-close-actions'
import {
  buildOpenTabSearchEntries,
  selectOpenTabSearchEntryState,
  selectOpenTabSearchAgentState
} from '../../components/tab-bar/open-tab-search-entries'
import { getEditorFileOperationContext } from '../../lib/editor-file-operation-owner'
import { attachEditorAutosaveController } from '../../components/editor/editor-autosave-controller'
import {
  createFakeEditorDisk,
  withLoadedBaselines
} from '../../components/editor/editor-autosave-controller-test-fixture'
import { requestEditorFileClose } from '../../components/editor/editor-autosave'
import { ensureWorktreeHasInitialTerminal } from '../../lib/worktree-initial-terminal-seeding'
import { useTerminalWatcherEffects } from '../../components/use-terminal-watcher-effects'
import { useFileExplorerHandlers } from '../../components/right-sidebar/useFileExplorerHandlers'
import { captureEditorFileOperationProvenance } from '../../lib/editor-file-operation-owner'
import { buildWorktreePurgeState } from './worktrees/teardown/worktree-purge-state'
import { activateBrowserWorkspaceTab } from '../../lib/browser-workspace-tab-activation'
import { activateAndRevealWorktree } from '../../lib/worktree-activation'

const confirmation = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../../components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirmation
}))
const holder = vi.hoisted((): { store?: StoreApi<AppState> } => ({}))
vi.mock('@/store', async (original) => {
  const actual = await original<typeof AppStoreModule>()
  const { useStore: useBoundStore } = await import('zustand')
  const current = () => {
    if (!holder.store) {
      throw new Error('missing test store')
    }
    return holder.store
  }
  return {
    ...actual,
    useAppStore: Object.assign(
      <T,>(selector: (state: AppState) => T) => useBoundStore(current(), selector),
      {
        getState: () => current().getState(),
        setState: (patch: Partial<AppState>) => current().setState(patch),
        subscribe: (listener: (state: AppState, previous: AppState) => void) =>
          current().subscribe(listener)
      }
    )
  }
})
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))
const domWindow = window
const api = createStoreSessionMockApi()
Object.assign(domWindow, { api })
Object.assign(globalThis, { window: domWindow })
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function editors() {
  const store = seedEditors()
  holder.store = store
  return store
}

it('mounts the real startup watcher and reselects a recovered dirty editor without seeding a shell', async () => {
  const store = editors()
  store.setState({ workspaceSessionReady: true, terminalStartupRestorationReady: true })
  const create = vi.fn(store.getState().createTab)
  const reconcile = vi.fn(store.getState().reconcileWorktreeTabModel)
  store.setState({ createTab: create, reconcileWorktreeTabModel: reconcile })
  const watcher = renderHook(() => {
    const state = store.getState()
    useTerminalWatcherEffects({
      ...state,
      activeWorktreeId: D,
      workspaceSessionReady: true,
      terminalStartupRestorationReady: true,
      hydrationSucceeded: false,
      workspaceSurfaceIds: [],
      activityTerminalPortals: [],
      anyMountedWorktreeHasLayout: false,
      backgroundMountRevision: 0,
      activationDeferredMountTabIdsByWorktreeRef: { current: new Map() },
      effectiveParkedTerminalWorktreeIds: new Set(),
      evictionExemptTerminalTabIds: new Set(),
      getEffectiveLayoutForWorktree: () => undefined,
      measurableBackgroundWorktreeIdsRef: { current: new Set() },
      mountedWorktreeIdsRef: { current: new Set() },
      pairedRuntimeParkingEnvironmentIds: new Set(),
      renderedActiveWorktreeId: D,
      startupTerminalTabHold: null,
      terminalParkingEnabled: false,
      terminalProviderSnapshotCapabilityRevision: 0,
      terminalSshParkingEnabled: false,
      terminalTitleSnapshotAuthorityEnabled: false
    })
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(activateAndRevealWorktree(D)).not.toBe(false)
  expect(reconcile).toHaveBeenCalledWith(D)
  expect(create).not.toHaveBeenCalled()
  expect(store.getState().unifiedTabsByWorktree[D].some((tab) => tab.entityId === 'owned')).toBe(
    true
  )
  expect(store.getState().editorDrafts.owned).toBe('unsaved original')
  expect(store.getState().openFiles.find((file) => file.id === 'owned')?.worktreeId).toBe(O)
  watcher.unmount()
})

it('keeps recovered files through default seeding/reselect and the actual file hook, nav, MRU and close consumers', async () => {
  const store = editors()
  const renders: string[][] = []
  function Files() {
    const owned = useWorktreeFiles(D)
    renders.push(owned.map((file) => file.id))
    return createElement('div', null, owned.map((file) => file.id).join(','))
  }
  const shown = render(createElement(Files))
  expect(shown.container.textContent).toBe('owned')
  expect(ensureWorktreeHasInitialTerminal(store.getState(), D)).toBeNull()
  store.getState().reconcileWorktreeTabModels([D])
  expect(store.getState().editorDrafts.owned).toBe('unsaved original')
  expect(store.getState().tabsByWorktree[D] ?? []).toHaveLength(0)
  expect(
    buildRecentTabSwitcherModel(store.getState(), D, 'mru')?.items.some(
      (item) => item.id === 'owned'
    )
  ).toBe(true)
  expect(
    buildRecentTabSwitcherModel(store.getState(), D, 'mru')?.items.some(
      (item) => item.id === 'foreign'
    )
  ).toBe(false)
  expect(deriveActiveSurfaceForWorktree(store.getState(), D).activeFileId).toBe('owned')
  const before = renders.length
  await act(async () => {
    store.getState().setTabLabel(C1, 'background content')
  })
  expect(renders).toHaveLength(before)
  await act(async () => {
    store.setState({
      worktreesByRepo: { ...rawWorkspaceState(store.getState()).worktreesByRepo, other: [] }
    })
  })
  expect(renders).toHaveLength(before)
  await act(async () => {
    store.setState((raw) => ({
      openFiles: [
        ...raw.openFiles,
        makeOpenFile({
          id: 'other-host-file',
          worktreeId: 'other::/repo',
          runtimeEnvironmentId: 'elsewhere'
        })
      ]
    }))
  })
  expect(renders).toHaveLength(before)
  await act(async () => {
    store.setState((raw) => ({
      openFiles: raw.openFiles.map((file) =>
        file.id === 'owned' ? { ...file, relativePath: 'changed.ts' } : file
      )
    }))
  })
  expect(renders).toHaveLength(before + 1)
  expect(shown.container.textContent).toBe('owned')
  const close = vi.fn()
  store.setState({
    closeFile: close,
    tabBarOrderByWorktree: { [D]: ['anchor', 'owned', 'foreign'] },
    openFiles: [...store.getState().openFiles, makeOpenFile({ id: 'anchor', worktreeId: D })]
  })
  // The legacy strip need not have a unified editor row to exclude a foreign owner.
  closeTerminalTabsToRight('anchor', D)
  expect(close).toHaveBeenCalledWith('owned')
  expect(close).not.toHaveBeenCalledWith('foreign')
  expect(workspaceAdmittedFiles(store.getState(), D).map((file) => file.id)).toEqual([
    'owned',
    'anchor'
  ])
})

it.each([200, 2000])(
  'does no unrelated file-id work for a warmed title update with %i bystanders',
  async (count) => {
    const store = editors()
    let reads = 0
    const bystanders = Array.from(
      { length: count },
      (_, id) =>
        new Proxy(makeOpenFile({ id: `bystander-${id}`, worktreeId: 'other::/files' }), {
          get(target, key, receiver) {
            if (key === 'id') {
              reads++
            }
            return Reflect.get(target, key, receiver)
          }
        })
    )
    const unrelated = makeUnifiedTab({ id: 'unrelated', worktreeId: 'unrelated::/repo' })
    store.setState((raw) => ({
      openFiles: [...raw.openFiles, ...bystanders],
      activeFileIdByWorktree: { [D]: 'owned' },
      unifiedTabsByWorktree: { ...raw.unifiedTabsByWorktree, 'unrelated::/repo': [unrelated] }
    }))
    let renders = 0
    renderHook(() => {
      renders++
      return useAppStore((state) => state.unifiedTabsByWorktree[D])
    })
    await act(async () => {
      await Promise.resolve()
    })
    const before = renders
    reads = 0
    await act(async () => {
      store.getState().setTabLabel('unrelated', 'Changed')
    })
    expect(store.getState().activeFileId).toBe('owned')
    expect(reads).toBe(0)
    expect(renders).toBe(before)
  }
)

function closeSurface(store: ReturnType<typeof editors>) {
  return renderHook(() => {
    const state = store.getState()
    const foundation = { ...state, ...useTerminalEditorCloseFoundation(state) }
    const queue = { ...foundation, ...useTerminalEditorCloseQueue(foundation) }
    const dialogs = useTerminalEditorCloseDialogActions(queue)
    const bulk = useTerminalBulkCloseActions({ ...queue, activeWorktreeId: D })
    return { ...queue, ...dialogs, ...bulk }
  })
}
it('builds the actual palette editor entry, and confirms only admitted clean/dirty close targets without moving their resource owner', async () => {
  const store = editors()
  const state = selectOpenTabSearchEntryState(store.getState(), D)!
  const entries = buildOpenTabSearchEntries(state, selectOpenTabSearchAgentState(store.getState()))
  expect(
    entries.workspaceTabs
      .filter((entry) => entry.tab.contentType === 'editor')
      .map((entry) => entry.tab.entityId)
  ).toEqual(['owned'])
  const clean = makeOpenFile({ id: 'clean', worktreeId: O })
  store.setState((raw) => ({
    openFiles: [...raw.openFiles, clean],
    tabBarOrderByWorktree: { [D]: ['anchor', 'owned', 'foreign', 'clean'] }
  }))
  const surface = closeSurface(store)
  await act(async () => {
    surface.result.current.handleCloseTabsToRight('anchor')
  })
  expect(confirmation).toHaveBeenCalled()
  expect(surface.result.current.saveDialogFileId).toBe('owned')
  expect(store.getState().activeWorktreeId).toBe(D)
  expect(store.getState().activeFileId).toBe('owned')
  expect(store.getState().openFiles.find((file) => file.id === 'owned')?.worktreeId).toBe(O)
  expect(store.getState().openFiles.some((file) => file.id === 'clean')).toBe(false)
  expect(store.getState().openFiles.some((file) => file.id === 'foreign')).toBe(true)
  act(() => surface.result.current.handleSaveDialogCancel())
  expect(surface.result.current.saveDialogFileId).toBeNull()
  expect(store.getState().editorDrafts.owned).toBe('unsaved original')
  expect(store.getState().openFiles.find((file) => file.id === 'owned')?.isDirty).toBe(true)
})
it('discards a recovered draft through the real dirty close queue while retaining foreign resources', async () => {
  const store = editors()
  const surface = closeSurface(store)
  act(() => requestEditorFileClose('owned'))
  expect(surface.result.current.saveDialogFileId).toBe('owned')
  await act(async () => surface.result.current.handleSaveDialogDiscard())
  expect(store.getState().editorDrafts.owned).toBeUndefined()
  expect(store.getState().openFiles.map((file) => file.id)).toEqual(['foreign'])
  expect(
    rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O].some(
      (tab) => tab.entityId === 'owned'
    )
  ).toBe(false)
  expect(store.getState().editorDrafts.foreign).toBe('other host')
})

it('saves and closes the recovered dirty file through the real autosave owner, without writing the foreign file', async () => {
  const store = editors()
  const disk = createFakeEditorDisk({ owned: 'before', foreign: 'foreign disk' })
  Object.assign(window.api, { fs: disk.fs })
  withLoadedBaselines(store, disk)
  const stop = attachEditorAutosaveController(store)
  const surface = closeSurface(store)
  try {
    act(() => requestEditorFileClose('owned'))
    await act(async () => surface.result.current.handleSaveDialogSave())
    expect(disk.files.get('owned')).toBe('unsaved original')
    expect(disk.files.get('foreign')).toBe('foreign disk')
    expect(disk.fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'owned', content: 'unsaved original' })
    )
    expect(
      getEditorFileOperationContext(store.getState(), { worktreeId: O }, 'C:\\repo')
    ).toMatchObject({ worktreeId: O, target: { kind: 'local' } })
    expect(store.getState().openFiles.map((file) => file.id)).toEqual(['foreign'])
  } finally {
    stop()
  }
})

it('reuses the genuine dirty resource through an actual Explorer click and link update, then restores a clean close through the display shortcut', async () => {
  const store = editors()
  const path = 'C:/repo/a.ts'
  const provenance = captureEditorFileOperationProvenance(store.getState(), O, null, true)
  store.setState((raw) => ({
    openFiles: raw.openFiles.map((file) =>
      file.id === 'owned'
        ? {
            ...file,
            filePath: path,
            relativePath: 'a.ts',
            isPreview: false,
            operationProvenance: provenance
          }
        : file
    )
  }))
  const explorer = renderHook(() =>
    useFileExplorerHandlers({
      activeWorktreeId: D,
      openFile: store.getState().openFile,
      makePreviewFilePermanent: store.getState().makePreviewFilePermanent,
      toggleDir: vi.fn(),
      loadDir: vi.fn(async () => false),
      statPath: vi.fn(async () => ({ isDirectory: false })),
      markPathAsDirectory: vi.fn(),
      setSelectedPath: vi.fn(),
      scrollRef: { current: null }
    })
  )
  await act(async () =>
    explorer.result.current.handleClick({
      name: 'a.ts',
      path,
      relativePath: 'a.ts',
      depth: 0,
      isDirectory: false,
      operationOwner: { kind: 'local' }
    })
  )
  expect(store.getState().openFiles).toHaveLength(2)
  expect(store.getState().openFiles.find((file) => file.id === 'owned')).toMatchObject({
    worktreeId: O,
    isDirty: true,
    isPreview: false,
    operationProvenance: provenance
  })
  expect(store.getState().editorDrafts.owned).toBe('unsaved original')
  expect(
    store.getState().unifiedTabsByWorktree[D].filter((tab) => tab.entityId === 'owned')
  ).toHaveLength(1)
  expect(store.getState().activeFileId).toBe('owned')
  expect(store.getState().pendingEditorFocusRequest).toMatchObject({
    fileId: 'owned',
    worktreeId: D,
    viewStateId: 'editor'
  })
  let settled: string | undefined
  act(() =>
    store.getState().openFileForLink(
      {
        worktreeId: D,
        filePath: path,
        relativePath: 'a.ts',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: false },
      null,
      (shown) => {
        settled = shown?.viewStateId
      }
    )
  )
  expect(settled).toBe('editor')
  expect(store.getState().openFiles.find((file) => file.id === 'owned')?.operationProvenance).toBe(
    provenance
  )
  // A normal clean close is captured under gesture D while the snapshot still names O.
  act(() => {
    store.getState().clearEditorDraft('owned')
    store.getState().markFileDirty('owned', false)
  })
  const queue = closeSurface(store)
  act(() => requestEditorFileClose('owned'))
  expect(queue.result.current.saveDialogFileId).toBeNull()
  expect(store.getState().openFiles.some((file) => file.id === 'owned')).toBe(false)
  expect(store.getState().recentlyClosedEditorTabsByWorktree[D][0]).toMatchObject({
    worktreeId: O,
    reopenId: 'owned',
    position: { groupId: 'left' }
  })
  let reopened = false
  act(() => {
    reopened = store.getState().reopenClosedTab(D)
  })
  expect(reopened).toBe(true)
  expect(store.getState().openFiles.find((file) => file.id === 'owned')?.worktreeId).toBe(O)
  expect(
    store.getState().unifiedTabsByWorktree[D].find((tab) => tab.entityId === 'owned')
  ).toMatchObject({ worktreeId: O, groupId: 'left' })
  expect(store.getState().activeFileId).toBe('owned')
  expect(store.getState().activeWorktreeId).toBe(D)
  act(() => store.getState().closeFile('owned'))
  // Independent U removal cannot make a cross-context snapshot survive genuine source purge.
  act(() => store.setState({ workspacePresentations: {} }))
  act(() => {
    store.getState().clearEditorDraft('foreign')
    store.getState().markFileDirty('foreign', false)
    store.getState().closeFile('foreign')
    store.setState({
      worktreesByRepo: {
        r: [
          ...store.getState().worktreesByRepo.r,
          makeWorktree({ id: O, repoId: 'r', path: 'C:/repo', hostId: 'local' }),
          makeWorktree({ id: O, repoId: 'r', path: 'C:/repo', hostId: 'runtime:box' })
        ]
      }
    })
    store.setState(buildWorktreePurgeState(store.getState(), [{ id: O, hostId: 'local' }]))
  })
  expect(
    store
      .getState()
      .recentlyClosedEditorTabsByWorktree[O]?.some((file) => file.runtimeEnvironmentId === 'box')
  ).toBe(true)
  expect(store.getState().recentlyClosedEditorTabsByWorktree[D] ?? []).toEqual([])
  expect(store.getState().reopenClosedTab(D)).toBe(false)
})

it('settles actual browser activation/page notification, source-owned close/undo and profile deletion through the composed context', async () => {
  const store = editors()
  const notify = vi.fn(async () => {})
  Object.assign(window.api, {
    browser: { notifyActiveTabChanged: notify, sessionDeleteProfile: vi.fn(async () => true) }
  })
  const workspace = store.getState().createBrowserTab(O, 'https://example.com/one', {
    targetGroupId: 'left',
    sessionProfileId: 'profile',
    activate: false
  })
  const second = store
    .getState()
    .createBrowserPage(workspace.id, 'https://example.com/two', { activate: false })
  expect(second).toBeTruthy()
  act(() => {
    expect(
      activateBrowserWorkspaceTab({ worktreeId: D, workspaceId: workspace.id, pageId: second!.id })
    ).toBe(true)
  })
  expect(store.getState().activeGroupIdByWorktree[D]).toBe('left')
  expect(store.getState().activeBrowserTabId).toBe(workspace.id)
  expect(
    store.getState().browserPagesByWorkspace[workspace.id].find((page) => page.id === second!.id)
      ?.worktreeId
  ).toBe(O)
  expect(
    store.getState().browserTabsByWorktree[D].find((tab) => tab.id === workspace.id)?.activePageId
  ).toBe(second!.id)
  expect(notify).toHaveBeenCalledWith({ browserPageId: second!.id })
  act(() => store.getState().closeBrowserTab(workspace.id))
  expect(store.getState().recentlyClosedBrowserTabsByWorktree[D][0]).toMatchObject({
    workspace: { worktreeId: O, sessionProfileId: 'profile' },
    position: { groupId: 'left' }
  })
  let reopened = false
  act(() => {
    reopened = store.getState().reopenClosedTab(D)
  })
  expect(reopened).toBe(true)
  const restored = store
    .getState()
    .browserTabsByWorktree[D].find((tab) => tab.sessionProfileId === 'profile')!
  expect(restored.worktreeId).toBe(O)
  expect(store.getState().browserPagesByWorkspace[restored.id].map((page) => page.url)).toEqual([
    'https://example.com/one',
    'https://example.com/two'
  ])
  expect(
    store.getState().unifiedTabsByWorktree[D].find((tab) => tab.entityId === restored.id)?.groupId
  ).toBe('left')
  act(() => store.getState().switchBrowserTabProfile(restored.id, 'other-profile', 'persist:other'))
  expect(
    rawWorkspaceState(store.getState()).browserTabsByWorktree[O].find(
      (tab) => tab.id === restored.id
    )
  ).toMatchObject({ sessionProfileId: 'other-profile', sessionPartition: 'persist:other' })
  const pages = store.getState().browserPagesByWorkspace[restored.id]
  act(() => store.getState().closeBrowserPage(pages[1].id))
  expect(store.getState().browserPagesByWorkspace[restored.id].map((page) => page.id)).toEqual([
    pages[0].id
  ])
  act(() => store.getState().closeBrowserTab(restored.id))
  expect(store.getState().browserTabsByWorktree[D] ?? []).not.toContainEqual(
    expect.objectContaining({ id: restored.id })
  )
  expect(rawWorkspaceState(store.getState()).browserTabsByWorktree[O] ?? []).not.toContainEqual(
    expect.objectContaining({ id: restored.id })
  )
  await act(async () => {
    expect(await store.getState().deleteBrowserSessionProfile('profile')).toBe(true)
  })
  expect(window.api.browser.sessionDeleteProfile).toHaveBeenCalledWith({ profileId: 'profile' })
  expect(store.getState().browserSessionProfiles.some((profile) => profile.id === 'profile')).toBe(
    false
  )
})

it('routes recovered Markdown document metadata and actual editor/preview outputs to the genuine source without moving display context', async () => {
  const store = editors()
  const active = {
    ...store.getState().openFiles[0],
    filePath: 'C:/repo/README.md',
    relativePath: 'README.md',
    language: 'markdown',
    runtimeEnvironmentId: null
  }
  store.setState({ openFiles: [active] })
  const document = {
    filePath: 'C:/repo/docs/guide.md',
    relativePath: 'docs/guide.md',
    basename: 'guide.md',
    name: 'Guide'
  }
  const list = vi.fn(async () => [document])
  const stat = vi.fn(async () => ({ isDirectory: false, size: 100, mtime: 1 }))
  Object.assign(window.api, { fs: { ...window.api.fs, listMarkdownDocuments: list, stat } })
  const hook = renderHook(() => useMarkdownDocuments(active, true, 'rich', async () => true))
  await waitFor(() => expect(hook.result.current.markdownDocuments).toEqual([document]))
  expect(list).toHaveBeenCalledWith({ rootPath: 'C:\\repo', connectionId: undefined })
  await act(async () => {
    await hook.result.current.openMarkdownDocument(document)
  })
  expect(stat).toHaveBeenCalledWith(expect.objectContaining({ filePath: document.filePath }))
  const opened = store
    .getState()
    .openFiles.find((file) => file.filePath === document.filePath && file.mode === 'edit')!
  expect(opened.worktreeId).toBe(O)
  expect(store.getState().activeWorktreeId).toBe(D)
  expect(
    store.getState().unifiedTabsByWorktree[D].find((tab) => tab.entityId === opened.id)
  ).toMatchObject({ worktreeId: O, groupId: 'left' })
  await act(async () => {
    await hook.result.current.openMarkdownDocument(document, { anchor: 'heading' })
  })
  const preview = store.getState().openFiles.find((file) => file.mode === 'markdown-preview')!
  expect(preview).toMatchObject({
    worktreeId: O,
    markdownPreviewSourceFileId: opened.id,
    markdownPreviewAnchor: 'heading'
  })
  expect(
    store.getState().unifiedTabsByWorktree[D].find((tab) => tab.entityId === preview.id)
  ).toMatchObject({ worktreeId: O, groupId: 'left' })
  expect(store.getState().activeFileId).toBe(preview.id)
  hook.unmount()
})

it('renders Session History saved names without mounting the chat or terminal surface', () => {
  const store = seed()
  holder.store = store
  const session: AiVaultSession = {
    id: 'history',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'chat1',
    title: 'Scanned title',
    cwd: 'C:/repo',
    branch: null,
    model: null,
    filePath: '',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '',
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    structuredSession: { sessionId: 'chat1', workspaceId: O }
  }
  function History() {
    return createElement('div', null, useAiVaultSessionDisplayTitle(session))
  }
  const row = render(createElement(History))
  expect(row.container.textContent).toBe('Saved name')
  act(() => store.getState().setTabCustomLabel(C1, 'History edit'))
  expect(row.container.textContent).toBe('History edit')
  row.unmount()
})

it('replaces source-owned previews through real close and restores a supported fresh shell in the displayed group', () => {
  const store = seed()
  holder.store = store
  const old = store.getState().openFile(
    {
      worktreeId: O,
      filePath: 'C:/repo/first.ts',
      relativePath: 'first.ts',
      language: 'typescript',
      mode: 'edit'
    },
    { preview: true, targetGroupId: 'left' }
  )
  expect(
    store.getState().unifiedTabsByWorktree[D].find((tab) => tab.entityId === old)?.worktreeId
  ).toBe(O)
  const next = store.getState().openFile(
    {
      worktreeId: D,
      filePath: 'C:/repo/next.ts',
      relativePath: 'next.ts',
      language: 'typescript',
      mode: 'edit'
    },
    { preview: true, targetGroupId: 'left', recordReplacedPreview: true }
  )
  expect(store.getState().openFiles.some((file) => file.id === old)).toBe(false)
  expect(
    rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O].some((tab) => tab.entityId === old)
  ).toBe(false)
  expect(store.getState().unifiedTabsByWorktree[D].some((tab) => tab.entityId === next)).toBe(true)
  expect(store.getState().recentlyClosedEditorTabsByWorktree[D][0]).toMatchObject({
    worktreeId: O,
    reopenId: old
  })
  const shell = store.getState().createTab(O, 'left', 'pwsh', { startupCwd: 'C:/repo/subdir' })
  store.getState().closeTab(shell.id)
  expect(store.getState().recentlyClosedTerminalTabsByWorktree[D][0]).toMatchObject({
    sourceWorkspaceId: O,
    startupCwd: 'C:/repo/subdir',
    position: { groupId: 'left' }
  })
  expect(store.getState().reopenClosedTab(D)).toBe(true)
  const restored = rawWorkspaceState(store.getState()).tabsByWorktree[O].find(
    (tab) => tab.id !== shell.id
  )!
  expect(restored).toMatchObject({
    worktreeId: O,
    startupCwd: 'C:/repo/subdir',
    shellOverride: 'pwsh',
    ptyId: null
  })
  expect(
    store.getState().unifiedTabsByWorktree[D].find((tab) => tab.entityId === restored.id)?.groupId
  ).toBe('left')
})
