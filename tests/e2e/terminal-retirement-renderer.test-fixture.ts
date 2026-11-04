import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import type { createStore } from '../../src/main/persistence/persistence-test-harness'
import type { setRuntimeDesktopSurface as SetRuntimeDesktopSurface } from '../../src/main/runtime/runtime-desktop-surface'

export async function loadRetirementRenderer(
  setRuntimeDesktopSurface: typeof SetRuntimeDesktopSurface
) {
  const { useAppStore } = await import('../../src/renderer/src/store')
  const { publishAgentLaunchTab } =
    await import('../../src/renderer/src/lib/agent-launch-tab-publication')
  const { buildWorkspaceSessionPayload } =
    await import('../../src/renderer/src/lib/workspace-session')
  const { createTabsSliceMockApi } =
    await import('../../src/renderer/src/store/slices/tabs-slice-test-harness')
  return async function setupRetirementRenderer(
    store: ReturnType<typeof createStore>,
    runtime: OrcaRuntimeService,
    workspaceId: string
  ) {
    const { setRuntimeGraphStoreStateGetter, setRuntimeGraphSyncEnabled } =
      await import('../../src/renderer/src/runtime/sync-runtime-graph')
    const { graphState, mobilePublicationEpoch } =
      await import('../../src/renderer/src/runtime/sync-runtime-graph/graph-state')
    const originalGraph = { ...graphState }
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalRenderer = useAppStore.getState()
    createTabsSliceMockApi()
    useAppStore.setState(useAppStore.getInitialState(), true)
    const persistRenderer = () =>
      store.setWorkspaceSession(buildWorkspaceSessionPayload(useAppStore.getState()))
    type CloseNotice = Parameters<Parameters<typeof window.api.ui.onCloseTerminal>[0]>[0]
    let closeNotice: ((target: CloseNotice) => void) | undefined
    const unsubscribeRenderer: (() => void)[] = []
    Object.assign(window.api, {
      projectGroups: { list: async () => store.getProjectGroups() },
      folderWorkspaces: { list: async () => store.getFolderWorkspaces() },
      runtime: {
        syncWindowGraph: async (graph: Parameters<OrcaRuntimeService['syncWindowGraph']>[1]) =>
          runtime.syncWindowGraph(1, graph)
      }
    })
    Object.assign(window.api.ui, {
      onOpenFileFromMobile: () => () => {},
      onOpenDiffFromMobile: () => () => {},
      onCloseTerminal: (listener: typeof closeNotice) => {
        closeNotice = listener
        return () => {
          closeNotice = undefined
        }
      },
      onWorkspaceSleep: () => () => {},
      onResumeSleepingAgents: () => () => {}
    })
    window.api.repos.list = async () => store.getRepos()
    await useAppStore
      .getState()
      .fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
    await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
    await useAppStore
      .getState()
      .fetchFolderWorkspaces({ runtimeEnvironmentId: null, throwOnError: true })
    const { registerMobileAndTerminalCloseIpcBridge } =
      await import('../../src/renderer/src/hooks/ipc-events/mobile-terminal-close-ipc-bridge')
    registerMobileAndTerminalCloseIpcBridge(unsubscribeRenderer, () => {})
    runtime.setNotifier({
      worktreesChanged: () => {},
      reposChanged: () => {},
      activateWorktree: () => {},
      createTerminal: () => {},
      splitTerminal: () => {},
      renameTerminal: () => {},
      focusTerminal: () => {},
      terminalFitOverrideChanged: () => {},
      terminalDriverChanged: () => {},
      closeTerminal: (tabId) => {
        if (!closeNotice) {
          throw new Error('renderer close consumer missing')
        }
        closeNotice({ kind: 'tab', tabId })
        persistRenderer()
      },
      publishAgentLaunchTab: async (request) => {
        const result = publishAgentLaunchTab({ ...request, requestId: randomUUID() })
        persistRenderer()
        return result
      }
    })
    setRuntimeDesktopSurface({
      showNotification: () => false,
      findWindowById: () =>
        ({
          isDestroyed: () => false,
          webContents: { isDestroyed: () => false, setBackgroundThrottling: () => {} }
        }) as never,
      onIpc: () => {},
      removeIpcListener: () => {}
    })
    runtime.attachWindow(1)
    Object.assign(graphState, {
      syncScheduled: false,
      syncInFlight: false,
      syncPendingAfterFlight: false,
      syncEnabled: false,
      syncTimer: null,
      mobileSessionSnapshotCacheByWorktree: new Map(),
      publishedMobileSessionSnapshotByWorktree: new Map(),
      cachedTabsProjection: null,
      cachedOpenFilesProjection: null,
      cachedBrowserWorkspacesProjection: null,
      cachedBrowserPagesProjection: null,
      cachedOpenFileIndexesSource: null,
      cachedOpenFileIndexes: null,
      cachedEditorDraftHashes: null,
      mobileSessionSnapshotVersion: 0,
      publishedTerminalGroupGridSizesKey: '',
      publishedProjectSectionCatalog: null,
      publishedActiveGroups: {}
    })
    setRuntimeGraphStoreStateGetter(() => useAppStore.getState())
    const { syncRuntimeGraph } =
      await import('../../src/renderer/src/runtime/sync-runtime-graph/graph-publication')
    const publishRenderer = async () => {
      setRuntimeGraphSyncEnabled(true)
      await syncRuntimeGraph()
      setRuntimeGraphSyncEnabled(false)
      const accepted = runtime['acceptedRendererMobileSnapshotByWorktree'].get(workspaceId)
      if (!accepted || accepted.publicationEpoch !== mobilePublicationEpoch) {
        throw new Error('generated folder publication was not accepted')
      }
    }
    return {
      renderer: useAppStore,
      persistRenderer,
      publishRenderer,
      stopGraphSync: () => {
        setRuntimeGraphSyncEnabled(false)
        setRuntimeGraphStoreStateGetter(null)
      },
      unsubscribeRenderer: () => {
        for (const unsubscribe of unsubscribeRenderer) {
          unsubscribe()
        }
      },
      restore: () => {
        setRuntimeDesktopSurface(null)
        useAppStore.setState(originalRenderer, true)
        Object.assign(graphState, originalGraph)
        if (originalWindow) {
          Object.defineProperty(globalThis, 'window', originalWindow)
        } else {
          delete (globalThis as { window?: unknown }).window
        }
      }
    }
  }
}
