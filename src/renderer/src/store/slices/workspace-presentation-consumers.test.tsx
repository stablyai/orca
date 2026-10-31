import { useAppStore } from '@/store'
import type * as AppStoreModule from '../index'
// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import type { StoreApi } from 'zustand'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { seed, O, D, C1 } from './workspace-presentation-test-fixture'
import { makeOpenFile, makeUnifiedTab } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { rawWorkspaceState } from '../workspace-source-state'
import { workspaceAdmittedFiles } from '../workspace-admitted-files'
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
  const store = seed()
  holder.store = store
  const raw = rawWorkspaceState(store.getState())
  const file = makeOpenFile({ id: 'owned', worktreeId: O, isDirty: true })
  const foreign = makeOpenFile({
    id: 'foreign',
    worktreeId: O,
    runtimeEnvironmentId: 'box',
    isDirty: true
  })
  store.setState({
    openFiles: [file, foreign],
    editorDrafts: { owned: 'unsaved original', foreign: 'other host' },
    unifiedTabsByWorktree: {
      ...raw.unifiedTabsByWorktree,
      [O]: [
        ...raw.unifiedTabsByWorktree[O],
        makeUnifiedTab({
          id: 'editor',
          entityId: file.id,
          worktreeId: O,
          groupId: 'source',
          contentType: 'editor'
        })
      ]
    }
  })
  store
    .getState()
    .moveUnifiedTabToGroup('editor', 'left', { activate: true, recordInteraction: false })
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
