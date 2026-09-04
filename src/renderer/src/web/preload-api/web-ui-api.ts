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
async function toHostUiUpdate(updates: Partial<PersistedUIState>): Promise<object> {
  const hostUpdates = omitPairingLocalUiFields(updates)
  if (!hasHostGatedUiFields(hostUpdates)) {
    return hostUpdates
  }
  return omitUnsupportedHostGatedUiFields(hostUpdates, await readHostUiCapabilities())
}

export function createWebUiApi(): NonNullable<Partial<PreloadApi>['ui']> {
  let zoomLevel = readLocalWebUIState().uiZoomLevel
  return {
    get: async () => {
      try {
        const result = await callRuntimeResult<{ ui: PairedUiState }>('ui.get', undefined, 15_000)
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
    set: async (updates) => {
      const next = mergeWebUIState(readLocalWebUIState(), updates)
      writeJson(UI_STORAGE_KEY, next)
      zoomLevel = next.uiZoomLevel
      try {
        await callRuntimeResult('ui.set', await toHostUiUpdate(updates), 15_000)
      } catch {
        // Why: unpaired/offline web clients still need local UI persistence.
      }
    },
    // Why a separate entry point: set must stay best-effort for its many fire-and-forget
    // callers, but the diff writer must NOT fold a patch the host never received into its
    // baseline — that write would silently never be retried (STA-5781).
    setWithAck: async (updates) => {
      const next = mergeWebUIState(readLocalWebUIState(), updates)
      writeJson(UI_STORAGE_KEY, next)
      zoomLevel = next.uiZoomLevel
      await callRuntimeResult('ui.set', await toHostUiUpdate(updates), 15_000)
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
