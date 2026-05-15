import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GlobalSettings } from '../../../../shared/types'
import { toast } from 'sonner'
import { callRuntimeRpc, clearRuntimeCompatibilityCache } from '@/runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'
import { normalizeTerminalQuickCommands } from '../../../../shared/terminal-quick-commands'
import { normalizeVisibleTaskProviders } from '../../../../shared/task-providers'

export type SettingsSlice = {
  settings: GlobalSettings | null
  settingsSearchQuery: string
  setSettingsSearchQuery: (q: string) => void
  fetchSettings: () => Promise<void>
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  switchRuntimeEnvironment: (environmentId: string | null) => Promise<boolean>
}

function normalizeRuntimeEnvironmentId(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function runtimeScopedStateReset(): Partial<AppState> {
  return {
    repos: [],
    activeRepoId: null,
    sparsePresetsByRepo: {},
    sparsePresetsLoadingByRepo: {},
    sparsePresetsLoadStatusByRepo: {},
    sparsePresetsErrorByRepo: {},
    worktreesByRepo: {},
    activeWorktreeId: null,
    deleteStateByWorktreeId: {},
    baseStatusByWorktreeId: {},
    remoteBranchConflictByWorktreeId: {},
    sortEpoch: 0,
    everActivatedWorktreeIds: new Set<string>(),
    lastVisitedAtByWorktreeId: {},
    hasHydratedWorktreePurge: false,
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    tabsByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    unreadTerminalTabs: {},
    suppressedPtyExitIds: {},
    pendingCodexPaneRestartIds: {},
    codexRestartNoticeByPtyId: {},
    expandedPaneByTabId: {},
    canExpandPaneByTabId: {},
    terminalLayoutsByTabId: {},
    pendingStartupByTabId: {},
    pendingSetupSplitByTabId: {},
    pendingIssueCommandSplitByTabId: {},
    tabBarOrderByWorktree: {},
    pendingReconnectWorktreeIds: [],
    pendingReconnectTabByWorktree: {},
    pendingReconnectPtyIdByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    pendingSnapshotByPtyId: {},
    pendingColdRestoreByPtyId: {},
    deferredSshReconnectTargets: [],
    deferredSshSessionIdsByTabId: {},
    cacheTimerByKey: {},
    expandedDirs: {},
    pendingExplorerReveal: null,
    openFiles: [],
    editorDrafts: {},
    markdownViewMode: {},
    editorViewMode: {},
    editorCursorLine: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    activeTabType: 'terminal',
    recentlyClosedEditorTabsByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    remoteBrowserPageHandlesByPageId: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    recentlyClosedBrowserTabsByWorktree: {},
    recentlyClosedBrowserPagesByWorkspace: {},
    pendingAddressBarFocusByTabId: {},
    pendingAddressBarFocusByPageId: {},
    browserSessionProfiles: [],
    browserSessionImportState: null,
    defaultBrowserSessionProfileId: null,
    detectedBrowsers: [],
    detectedBrowsersLoaded: false,
    prCache: {},
    issueCache: {},
    checksCache: {},
    commentsCache: {},
    workItemsCache: {},
    workItemsInvalidationNonce: 0,
    projectViewCache: {},
    linearStatus: { connected: false, viewer: null },
    linearStatusChecked: false,
    linearIssueCache: {},
    linearSearchCache: {}
  }
}

function hasUnsavedEditorState(state: AppState): boolean {
  return state.openFiles.some((file) => file.isDirty || state.editorDrafts[file.id] !== undefined)
}

async function closeRemoteBrowserPagesBeforeRuntimeSwitch(state: AppState): Promise<void> {
  const worktreeIdByPageId = new Map<string, string>()
  for (const pages of Object.values(state.browserPagesByWorkspace)) {
    for (const page of pages) {
      worktreeIdByPageId.set(page.id, page.worktreeId)
    }
  }
  await Promise.allSettled(
    Object.entries(state.remoteBrowserPageHandlesByPageId).map(([pageId, handle]) => {
      const worktreeId = worktreeIdByPageId.get(pageId)
      if (!worktreeId) {
        return Promise.resolve()
      }
      return callRuntimeRpc(
        { kind: 'environment', environmentId: handle.environmentId },
        'browser.tabClose',
        { worktree: `id:${worktreeId}`, page: handle.remotePageId },
        { timeoutMs: 15_000 }
      )
    })
  )
}

function collectRemoteTerminalHandlesForRuntimeSwitch(
  state: AppState,
  fallbackEnvironmentId: string | null
): Map<string, Set<string>> {
  const handlesByEnvironmentId = new Map<string, Set<string>>()
  const collect = (ptyId: string | null | undefined): void => {
    if (!ptyId) {
      return
    }
    const handle = getRemoteRuntimeTerminalHandle(ptyId)
    if (!handle) {
      return
    }
    const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId) ?? fallbackEnvironmentId
    if (!environmentId) {
      return
    }
    const handles = handlesByEnvironmentId.get(environmentId) ?? new Set<string>()
    handles.add(handle)
    handlesByEnvironmentId.set(environmentId, handles)
  }

  for (const ptyIds of Object.values(state.ptyIdsByTabId)) {
    for (const ptyId of ptyIds) {
      collect(ptyId)
    }
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      collect(tab.ptyId)
    }
  }
  for (const layout of Object.values(state.terminalLayoutsByTabId)) {
    for (const ptyId of Object.values(layout.ptyIdsByLeafId ?? {})) {
      collect(ptyId)
    }
  }
  return handlesByEnvironmentId
}

async function closeRemoteTerminalsBeforeRuntimeSwitch(
  state: AppState,
  fallbackEnvironmentId: string | null
): Promise<void> {
  const handlesByEnvironmentId = collectRemoteTerminalHandlesForRuntimeSwitch(
    state,
    fallbackEnvironmentId
  )
  await Promise.allSettled(
    Array.from(handlesByEnvironmentId.entries()).flatMap(([environmentId, handles]) =>
      Array.from(handles).map((terminal) =>
        callRuntimeRpc(
          { kind: 'environment', environmentId },
          'terminal.close',
          { terminal },
          { timeoutMs: 15_000 }
        )
      )
    )
  )
}

async function verifyRuntimeEnvironmentReachable(environmentId: string | null): Promise<void> {
  if (!environmentId) {
    return
  }
  await callRuntimeRpc({ kind: 'environment', environmentId }, 'repo.list', undefined, {
    timeoutMs: 15_000
  })
}

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set, get) => ({
  settings: null,
  settingsSearchQuery: '',
  setSettingsSearchQuery: (q) => set({ settingsSearchQuery: q }),

  fetchSettings: async () => {
    try {
      const settings = await window.api.settings.get()
      set({ settings })
    } catch (err) {
      console.error('Failed to fetch settings:', err)
    }
  },

  updateSettings: async (updates) => {
    try {
      const sanitizedUpdates = { ...updates }
      if ('terminalQuickCommands' in updates) {
        sanitizedUpdates.terminalQuickCommands = normalizeTerminalQuickCommands(
          updates.terminalQuickCommands
        )
      }
      if ('visibleTaskProviders' in updates) {
        sanitizedUpdates.visibleTaskProviders = normalizeVisibleTaskProviders(
          updates.visibleTaskProviders
        )
      }
      await window.api.settings.set(sanitizedUpdates)
      set((s) => {
        if (!s.settings) {
          return { settings: null }
        }
        // Deep-merge telemetry so partial writes do not clobber sibling
        // fields like `installId`, `existedBeforeTelemetryRelease`, or
        // `optedIn` in local renderer state until the next fetchSettings.
        // Mirrors the main-side merge in src/main/persistence.ts:551-573.
        // `telemetry` is optional on GlobalSettings, so guard against the case
        // where both current and incoming telemetry are undefined — otherwise
        // the spread would produce an empty object and we'd materialize a
        // telemetry key that shouldn't exist.
        const mergedTelemetry =
          sanitizedUpdates.telemetry !== undefined
            ? { ...s.settings.telemetry, ...sanitizedUpdates.telemetry }
            : s.settings.telemetry
        // Why: voice is optional and partially writable (e.g. only `selectedModelId`
        // changes), so deep-merge sibling fields like `mode` and `holdShortcut`
        // and avoid materializing a `voice` key when neither current nor incoming
        // settings define one.
        const mergedVoice =
          updates.voice !== undefined ? { ...s.settings.voice, ...updates.voice } : s.settings.voice
        return {
          settings: {
            ...s.settings,
            ...sanitizedUpdates,
            notifications: {
              ...s.settings.notifications,
              ...sanitizedUpdates.notifications
            },
            ...(mergedTelemetry !== undefined ? { telemetry: mergedTelemetry } : {}),
            ...(mergedVoice !== undefined ? { voice: mergedVoice } : {})
          }
        }
      })
    } catch (err) {
      console.error('Failed to update settings:', err)
    }
  },

  switchRuntimeEnvironment: async (environmentId) => {
    const nextId = normalizeRuntimeEnvironmentId(environmentId)
    const previousId = normalizeRuntimeEnvironmentId(get().settings?.activeRuntimeEnvironmentId)
    if (previousId === nextId) {
      return true
    }
    if (hasUnsavedEditorState(get())) {
      toast.error('Save or close unsaved editor tabs before switching servers.')
      return false
    }
    try {
      clearRuntimeCompatibilityCache(nextId)
      await verifyRuntimeEnvironmentReachable(nextId)
      // Why: remote browser tabs live on their owning server. Close them before
      // clearing browser maps so the old server does not retain orphan pages.
      await closeRemoteTerminalsBeforeRuntimeSwitch(get(), previousId)
      await closeRemoteBrowserPagesBeforeRuntimeSwitch(get())
      await window.api.settings.set({ activeRuntimeEnvironmentId: nextId })
      set((s) => ({
        ...runtimeScopedStateReset(),
        settings: s.settings ? { ...s.settings, activeRuntimeEnvironmentId: nextId } : null
      }))
      // Why: server-owned state is cleared before refetch so old worktree,
      // terminal, browser, and issue IDs cannot be used against the new server
      // while the new environment is loading.
      await get().fetchRepos()
      await get().fetchAllWorktrees()
      await get().fetchBrowserSessionProfiles()
      return true
    } catch (err) {
      console.error('Failed to switch runtime environment:', err)
      toast.error('Failed to switch servers', {
        description: err instanceof Error ? err.message : String(err)
      })
      return false
    }
  }
})
