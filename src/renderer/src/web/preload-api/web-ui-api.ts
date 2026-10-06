import { createWebExplorerRootSync } from './web-explorer-root-sync'
import type { PreloadApi } from '../../../../preload/api-types'
import { assertClipboardTextWithinLimitWithYield } from '../../../../shared/clipboard-text'
import type { ReadClipboardTextOptions } from '../../../../shared/clipboard-text'
import { normalizeFeatureInteractions } from '../../../../shared/feature-interactions'
import type { FeatureInteractionId } from '../../../../shared/feature-interactions'
import {
  hasHostGatedUiFields,
  omitUnsupportedHostGatedUiFields
} from '../../../../shared/host-gated-ui-fields'
import { omitPairingLocalUiFields } from '../../../../shared/pairing-local-ui-fields'
import type { PairedUiState } from '../../../../shared/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import {
  clipboardHasImage,
  readClipboardImagePngBase64,
  readClipboardImageThumbnail,
  saveClipboardImageAsTempFileInRuntime,
  writeWebClipboardText
} from './web-clipboard-api'
import {
  mergeContextualTourSeenIds,
  mergeFeatureInteractionState,
  mergeHostWebUIState,
  mergeOsc52ClipboardNoticePending,
  mergeWebUIState
} from './web-preference-normalization'
import { readLocalWebUIState } from './web-preferences-store'
import { callRuntimeResult, getRemoteRuntimeStatus } from './web-runtime-calls'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import { UI_STORAGE_KEY, noopUnsubscribe, writeJson } from './web-storage'

// Why a TTL and not a permanent answer: the host can be updated in place under a paired
// browser, and a gated key stripped forever would never reach the host that now accepts it.
const HOST_UI_CAPABILITIES_TTL_MS = 5 * 60_000
let hostUiCapabilities: {
  environmentId: string
  readAt: number
  capabilities: readonly string[]
} | null = null

async function readHostUiCapabilities(): Promise<readonly string[] | null> {
  const environment = requireActiveEnvironmentOrNull()
  if (!environment) {
    return null
  }
  if (
    hostUiCapabilities?.environmentId === environment.id &&
    Date.now() - hostUiCapabilities.readAt < HOST_UI_CAPABILITIES_TTL_MS
  ) {
    return hostUiCapabilities.capabilities
  }
  const status = await getRemoteRuntimeStatus().catch(() => null)
  if (!status) {
    return null
  }
  const capabilities = status.capabilities ?? []
  hostUiCapabilities = { environmentId: environment.id, readAt: Date.now(), capabilities }
  return capabilities
}

/** Reset the host capability cache; exported for tests. */
export function resetHostUiCapabilitiesForTest(): void {
  hostUiCapabilities = null
}

// Why strip here too when the host also strips pairing-local keys: an old host predating that
// strip would otherwise persist this browser's runtime:web-* keys over the desktop profile's
// order. Host-gated keys are asked about only when present, so ordinary writes cost no extra RPC.
async function toHostUiUpdate(
  updates: Partial<PersistedUIState>
): Promise<Partial<PairedUiState>> {
  const hostUpdates = omitPairingLocalUiFields(updates)
  if (!hasHostGatedUiFields(hostUpdates)) {
    return hostUpdates
  }
  return omitUnsupportedHostGatedUiFields(hostUpdates, await readHostUiCapabilities())
}

/** Combines browser-local preferences with host persistence; acknowledged writes remain distinct from best-effort writes. */
export function createWebUiApi(): NonNullable<Partial<PreloadApi>['ui']> {
  const explorerRoots = createWebExplorerRootSync()
  /** Captures the target host and strips browser-local or unsupported fields before sending a UI update. */
  const prepareHostUpdates = async (updates: Parameters<PreloadApi['ui']['set']>[0]) => {
    const environmentId = requireActiveEnvironmentOrNull()?.id
    const hostUpdates = await toHostUiUpdate(updates)
    if (requireActiveEnvironmentOrNull()?.id !== environmentId) {
      throw new Error('UI persistence environment changed during capability discovery')
    }
    explorerRoots.prepare(environmentId, hostUpdates)
    return { environmentId, hostUpdates }
  }
  let zoomLevel = readLocalWebUIState().uiZoomLevel
  return {
    /** Hydrates from the active host after replaying pending roots, falling back to local state on failure or host changes. */
    get: async () => {
      try {
        const environmentId = requireActiveEnvironmentOrNull()?.id
        const result = await callRuntimeResult<{ ui: PairedUiState }>('ui.get', undefined, 15_000)
        if (environmentId !== requireActiveEnvironmentOrNull()?.id) {
          return readLocalWebUIState()
        }
        await explorerRoots.read(environmentId, result.ui)
        if (environmentId !== requireActiveEnvironmentOrNull()?.id) {
          return readLocalWebUIState()
        }
        const local = readLocalWebUIState()
        const next = {
          ...mergeHostWebUIState(local, result.ui),
          osc52ClipboardDefaultOnNoticePending: mergeOsc52ClipboardNoticePending(local, result.ui),
          featureInteractions: mergeFeatureInteractionState(
            local.featureInteractions,
            result.ui.featureInteractions
          ),
          contextualToursSeenIds: mergeContextualTourSeenIds(
            local.contextualToursSeenIds,
            result.ui.contextualToursSeenIds
          )
        }
        writeJson(UI_STORAGE_KEY, next)
        zoomLevel = next.uiZoomLevel
        return next
      } catch {
        return readLocalWebUIState()
      }
    },
    /** Persists locally first and attempts the host write without propagating offline failures to fire-and-forget callers. */
    set: async (updates) => {
      const next = mergeWebUIState(readLocalWebUIState(), updates)
      writeJson(UI_STORAGE_KEY, next)
      zoomLevel = next.uiZoomLevel
      // Why strip here too when the host also strips: an old host predating that strip would
      // otherwise persist this browser's runtime:web-* keys over the desktop profile's order.
      try {
        const { environmentId, hostUpdates } = await prepareHostUpdates(updates)
        await callRuntimeResult('ui.set', hostUpdates, 15_000)
        explorerRoots.acknowledge(environmentId, hostUpdates)
      } catch {
        // Why: unpaired/offline web clients still need local UI persistence.
      }
    },
    /** Rejects failed or stripped host updates so the diff writer cannot acknowledge preferences the host never received. */
    setWithAck: async (updates) => {
      const next = mergeWebUIState(readLocalWebUIState(), updates)
      writeJson(UI_STORAGE_KEY, next)
      zoomLevel = next.uiZoomLevel
      const { environmentId, hostUpdates } = await prepareHostUpdates(updates)
      await callRuntimeResult('ui.set', hostUpdates, 15_000)
      explorerRoots.acknowledge(environmentId, hostUpdates)
      if (
        updates.explorerDisplayRootByWorktree !== undefined &&
        hostUpdates.explorerDisplayRootByWorktree === undefined
      ) {
        throw new Error('Explorer root preference is pending host support')
      }
    },
    recordFeatureInteraction: async (id: FeatureInteractionId) => {
      const current = readLocalWebUIState()
      const featureInteractions = normalizeFeatureInteractions(current.featureInteractions)
      const existing = featureInteractions[id]
      const optimistic = mergeWebUIState(current, {
        featureInteractions: {
          ...featureInteractions,
          [id]: {
            firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
            interactionCount: (existing?.interactionCount ?? 0) + 1
          }
        }
      })
      writeJson(UI_STORAGE_KEY, optimistic)
      try {
        const result = await callRuntimeResult<{ ui: PairedUiState }>(
          'ui.recordFeatureInteraction',
          id,
          15_000
        )
        const local = readLocalWebUIState()
        const next = {
          ...mergeHostWebUIState(local, result.ui),
          osc52ClipboardDefaultOnNoticePending: mergeOsc52ClipboardNoticePending(local, result.ui),
          featureInteractions: mergeFeatureInteractionState(
            local.featureInteractions,
            result.ui.featureInteractions
          ),
          contextualToursSeenIds: mergeContextualTourSeenIds(
            local.contextualToursSeenIds,
            result.ui.contextualToursSeenIds
          )
        }
        writeJson(UI_STORAGE_KEY, next)
        zoomLevel = next.uiZoomLevel
        return next
      } catch {
        return optimistic
      }
    },
    readClipboardText: async (options?: ReadClipboardTextOptions) =>
      assertClipboardTextWithinLimitWithYield(
        await (navigator.clipboard?.readText?.() ?? ''),
        options
      ),
    readSelectionClipboardText: () =>
      Promise.reject(new Error('Selection clipboard is unavailable in the web client')),
    saveClipboardImageAsTempFile: async (args?: {
      connectionId?: string | null
      runtimeEnvironmentId?: string | null
    }) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      const contentBase64 = await readClipboardImagePngBase64()
      if (!contentBase64) {
        return null
      }
      return saveClipboardImageAsTempFileInRuntime(contentBase64, args)
    },
    clipboardHasImage,
    // Browsers expose copied files only inside a paste event.
    readClipboardFilePaths: async () => [],
    // Why empty: a browser has no local paste folder, so restored pastes stay to attach again.
    restoreNativeChatPastes: async () => [],
    readClipboardImageThumbnail: () => readClipboardImageThumbnail().catch(() => null),
    writeClipboardText: writeWebClipboardText,
    writeTerminalClipboardText: writeWebClipboardText,
    writeSelectionClipboardText: () =>
      Promise.reject(new Error('Selection clipboard is unavailable in the web client')),
    writeClipboardImage: () => Promise.resolve(),
    writeClipboardFile: () => Promise.resolve({ ok: false, reason: 'unsupported-platform' }),
    performNativePaste: () => {
      document.execCommand?.('paste')
    },
    performNativeSelectionAction: (action) => {
      document.execCommand?.(action === 'copy' ? 'copy' : 'selectAll')
    },
    onExportPdfRequested: () => noopUnsubscribe,
    onAppMenuPaste: () => noopUnsubscribe,
    onAppMenuSelectionAction: () => noopUnsubscribe,
    onEditableContextPaste: () => noopUnsubscribe,
    getZoomLevel: () => zoomLevel,
    setZoomLevel: (level) => {
      zoomLevel = level
    },
    isMaximized: () => Promise.resolve(false),
    onOpenSettings: () => noopUnsubscribe,
    // Why: the web client has no native tray/menu bar, so there's never a queued open-settings intent to consume.
    consumePendingOpenSettings: () => Promise.resolve(false),
    onOpenSkillShare: () => noopUnsubscribe,
    consumePendingSkillShare: () => Promise.resolve(null),
    // Why: the web client has no OS shell handing it files, so there is never a queued open.
    onOpenMarkdownFiles: () => noopUnsubscribe,
    consumePendingMarkdownFileOpens: () => Promise.resolve([]),
    onOpenSetupGuide: () => noopUnsubscribe,
    onOpenFeatureTour: () => noopUnsubscribe,
    onOpenCrashReport: () => noopUnsubscribe,
    // No desktop main process to push state changes; the web client re-reads via ui.get on interaction.
    onStateChanged: () => noopUnsubscribe,
    onToggleLeftSidebar: () => noopUnsubscribe,
    onToggleRightSidebar: () => noopUnsubscribe,
    onToggleWorktreePalette: () => noopUnsubscribe,
    onToggleFloatingTerminal: () => noopUnsubscribe,
    onTerminalShortcutCaptured: () => noopUnsubscribe,
    onOpenQuickOpen: () => noopUnsubscribe,
    onToggleQuickCommandsMenu: () => noopUnsubscribe,
    onOpenTasks: () => noopUnsubscribe,
    onOpenNewWorkspace: () => noopUnsubscribe,
    onDeleteCurrentWorkspace: () => noopUnsubscribe,
    onOpenWorkspaceBoard: () => noopUnsubscribe,
    onToggleAgentDashboard: () => noopUnsubscribe,
    onJumpToWorktreeIndex: () => noopUnsubscribe,
    onJumpToTabIndex: () => noopUnsubscribe,
    onWorktreeHistoryNavigate: () => noopUnsubscribe,
    onNewBrowserTab: () => noopUnsubscribe,
    onNewMarkdownTab: () => noopUnsubscribe,
    onNewSimulatorTab: () => noopUnsubscribe,
    onRequestTabCreate: () => noopUnsubscribe,
    replyTabCreate: () => {},
    onRequestTabSetProfile: () => noopUnsubscribe,
    replyTabSetProfile: () => {},
    onRequestTabClose: () => noopUnsubscribe,
    replyTabClose: () => {},
    onNewTerminalTab: () => noopUnsubscribe,
    onFocusBrowserAddressBar: () => noopUnsubscribe,
    onFindInBrowserPage: () => noopUnsubscribe,
    onReloadBrowserPage: () => noopUnsubscribe,
    onBrowserHistoryNavigate: () => noopUnsubscribe,
    onZoomBrowserPage: () => noopUnsubscribe,
    onHardReloadBrowserPage: () => noopUnsubscribe,
    onCloseActiveTab: () => noopUnsubscribe,
    onCloseFloatingItem: () => noopUnsubscribe,
    onSelectFloatingIndex: () => noopUnsubscribe,
    onSwitchTab: () => noopUnsubscribe,
    onSwitchTabAcrossAllTypes: () => noopUnsubscribe,
    onSwitchRecentTab: () => noopUnsubscribe,
    onSwitchTerminalTab: () => noopUnsubscribe,
    onCtrlTabKeyDown: () => noopUnsubscribe,
    onCtrlTabKeyUp: () => noopUnsubscribe,
    onToggleStatusBar: () => noopUnsubscribe,
    onDictationKeyDown: () => noopUnsubscribe,
    onActivateWorktree: () => noopUnsubscribe,
    onCreateTerminal: () => noopUnsubscribe,
    onRequestTerminalCreate: () => noopUnsubscribe,
    onRequestTerminalTabMount: () => noopUnsubscribe,
    replyTerminalCreate: () => {},
    onSplitTerminal: () => noopUnsubscribe,
    onRenameTerminal: () => noopUnsubscribe,
    onFocusTerminal: () => noopUnsubscribe,
    onFocusEditorTab: () => noopUnsubscribe,
    onCloseSessionTab: () => noopUnsubscribe,
    onSessionTabCloseRequest: () => noopUnsubscribe,
    respondSessionTabClose: () => {},
    onMoveSessionTab: () => noopUnsubscribe,
    onOpenFileFromMobile: () => noopUnsubscribe,
    onOpenDiffFromMobile: () => noopUnsubscribe,
    onMobileMarkdownRequest: () => noopUnsubscribe,
    respondMobileMarkdownRequest: () => {},
    onCloseTerminal: () => noopUnsubscribe,
    onTerminalTabCloseRequest: () => noopUnsubscribe,
    respondTerminalTabClose: () => {},
    onSleepWorktree: () => noopUnsubscribe,
    // Why: paired web is a full renderer that wakes on activation; mobile wake is desktop-host-scoped and never reaches web.
    onResumeSleepingAgents: () => noopUnsubscribe,
    onTerminalZoom: () => noopUnsubscribe,
    // Why: a paired web client has no OS sleep signal; occlusion-driven visibilitychange already covers wake recovery.
    onSystemResumed: () => noopUnsubscribe,
    onFileDrop: () => noopUnsubscribe,
    syncTrafficLights: () => {},
    setMarkdownEditorFocused: () => {},
    setRichMarkdownContextMenuTarget: () => {},
    setTerminalInputFocused: () => {},
    setFloatingFocus: () => {},
    setShortcutRecorderFocused: () => {},
    onRichMarkdownContextCommand: () => noopUnsubscribe,
    onFullscreenChanged: () => noopUnsubscribe,
    minimize: () => {},
    maximize: () => {},
    onMaximizeChanged: () => noopUnsubscribe,
    requestClose: () => {},
    popupMenu: () => {},
    onWindowCloseRequested: () => noopUnsubscribe,
    confirmWindowClose: () => {},
    notifyWindowRevealed: () => {}
  }
}
