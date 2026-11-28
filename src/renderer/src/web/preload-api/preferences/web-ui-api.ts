import { subscribeWebWorkspaceSleep } from '../workspaces/web-workspace-sleep-notices'
import { savePastedTextAsWebAgentSessionAttachment } from '../agents/web-pasted-text-upload'
import { createWebExplorerRootSync } from '../workspaces/web-explorer-root-sync'
import { createWebJiraFilterStateApi } from '../jira/web-jira-filter-state-api'
import { WEB_PENDING_LINK_API } from './web-pending-link-api'
import { createWebUiNativeWindowApi } from './web-ui-native-window'
import type { PreloadApi } from '../../../../../preload/api-types'
import {
  readWebClipboardPasteContent,
  readWebClipboardText
} from '../clipboard/web-clipboard-paste-content'
import { normalizeFeatureInteractions } from '../../../../../shared/feature-education/interactions/feature-interactions'
import type { FeatureInteractionId } from '../../../../../shared/feature-education/interactions/feature-interaction-catalog'
import { omitPairingLocalUiFields } from '../../../../../shared/remote-runtime/pairing/pairing-local-ui-fields'
import type { PairedUiState } from '../../../../../shared/remote-runtime/pairing/pairing-local-ui-fields'
import {
  clipboardHasImage,
  readClipboardImageThumbnail,
  saveWebClipboardImageAsTempFile,
  writeWebClipboardImage,
  writeWebSecretClipboardText,
  writeWebClipboardText
} from '../clipboard/web-clipboard-api'
import {
  mergeContextualTourSeenIds,
  mergeFeatureInteractionState,
  mergeHostWebUIState,
  mergeOsc52ClipboardNoticePending,
  mergeWebUIState,
  readLocalWebUIState
} from './web-ui-state'
import { callRuntimeResult } from '../../runtime/client/web-runtime-calls'
import { requireActiveEnvironmentOrNull } from '../../runtime/client/web-runtime-session'
import { UI_STORAGE_KEY, noopUnsubscribe, writeJson } from '../web-storage'
import { writeWebChatReadMarkEdits, type WebChatReadMarks } from './web-chat-read-mark-storage'

type UIUpdates = Parameters<PreloadApi['ui']['set']>[0]
export type WebUiApi = NonNullable<PreloadApi['ui']> & {
  setPersistedUIWithAck: (
    updates: UIUpdates,
    marks: Partial<WebChatReadMarks>,
    baseline: WebChatReadMarks
  ) => { marks: WebChatReadMarks; request: Promise<void> }
}

/** Combines browser-local preferences with host persistence; acknowledged writes remain distinct from best-effort writes. */
export function createWebUiApi(): WebUiApi {
  const explorerRoots = createWebExplorerRootSync()
  /** Captures the target host and strips browser-local or unsupported fields before sending a UI update. */
  const prepareHostUpdates = (updates: UIUpdates) => {
    const environmentId = requireActiveEnvironmentOrNull()?.id
    const hostUpdates = omitPairingLocalUiFields(updates)
    explorerRoots.prepare(environmentId, hostUpdates)
    return { environmentId, hostUpdates }
  }
  const sendHostUpdatesWithAck = async (updates: UIUpdates): Promise<void> => {
    const { environmentId, hostUpdates } = prepareHostUpdates(updates)
    await callRuntimeResult('ui.set', hostUpdates, 15_000)
    explorerRoots.acknowledge(environmentId, hostUpdates)
    if (
      updates.explorerDisplayRootByWorktree !== undefined &&
      hostUpdates.explorerDisplayRootByWorktree === undefined
    ) {
      throw new Error('Explorer root preference is pending host support')
    }
  }
  let zoomLevel = readLocalWebUIState().uiZoomLevel
  const persistLocalUpdates = (updates: UIUpdates): void => {
    const next = mergeWebUIState(readLocalWebUIState(), updates)
    writeJson(UI_STORAGE_KEY, next)
    zoomLevel = next.uiZoomLevel
  }
  const persistHostState = (incoming: PairedUiState) => {
    const local = readLocalWebUIState()
    const next = {
      ...mergeHostWebUIState(local, incoming),
      osc52ClipboardDefaultOnNoticePending: mergeOsc52ClipboardNoticePending(local, incoming),
      featureInteractions: mergeFeatureInteractionState(
        local.featureInteractions,
        incoming.featureInteractions
      ),
      contextualToursSeenIds: mergeContextualTourSeenIds(
        local.contextualToursSeenIds,
        incoming.contextualToursSeenIds
      )
    }
    writeJson(UI_STORAGE_KEY, next)
    zoomLevel = next.uiZoomLevel
    return next
  }
  return {
    ...createWebJiraFilterStateApi(),
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
        return persistHostState(result.ui)
      } catch {
        return readLocalWebUIState()
      }
    },
    /** Persists locally first and attempts the host write without propagating offline failures to fire-and-forget callers. */
    set: async (updates) => {
      persistLocalUpdates(updates)
      // Older hosts lack stripping; sending browser runtime:web-* keys would overwrite desktop order.
      const { environmentId, hostUpdates } = prepareHostUpdates(updates)
      try {
        await callRuntimeResult('ui.set', hostUpdates, 15_000)
        explorerRoots.acknowledge(environmentId, hostUpdates)
      } catch {
        // Why: unpaired/offline web clients still need local UI persistence.
      }
    },
    /** Rejects failed or stripped host updates so the diff writer cannot acknowledge preferences the host never received. */
    setWithAck: async (updates) => {
      persistLocalUpdates(updates)
      await sendHostUpdatesWithAck(updates)
    },
    setPersistedUIWithAck: (updates, marks, baseline) => {
      let nextZoomLevel = zoomLevel
      const persisted = readLocalWebUIState((project) =>
        writeWebChatReadMarkEdits(marks, baseline, {
          mergeUI: (stored) => {
            const next = mergeWebUIState(project(stored), updates)
            nextZoomLevel = next.uiZoomLevel
            return next
          }
        })
      )
      zoomLevel = nextZoomLevel
      return { marks: persisted, request: sendHostUpdatesWithAck(updates) }
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
        return persistHostState(result.ui)
      } catch {
        return optimistic
      }
    },
    readClipboardText: readWebClipboardText,
    readClipboardPasteContent: readWebClipboardPasteContent,
    readSelectionClipboardText: () =>
      Promise.reject(new Error('Selection clipboard is unavailable in the web client')),
    saveClipboardImageAsTempFile: saveWebClipboardImageAsTempFile,
    savePastedTextAsFile: savePastedTextAsWebAgentSessionAttachment,
    clipboardHasImage,
    // Why empty: a browser has no local paste folder, so restored pastes stay to attach again.
    restoreNativeChatPastes: async () => [],
    onAgentSessionUploadRemoved: () => noopUnsubscribe,
    readClipboardImageThumbnail: () => readClipboardImageThumbnail().catch(() => null),
    writeClipboardText: writeWebClipboardText,
    writeTerminalClipboardText: writeWebClipboardText,
    writeSecretClipboardText: writeWebSecretClipboardText,
    writeSelectionClipboardText: () =>
      Promise.reject(new Error('Selection clipboard is unavailable in the web client')),
    writeClipboardImage: writeWebClipboardImage,
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
    isWindowActive: () => Promise.resolve(document.hasFocus()),
    onOpenSettings: () => noopUnsubscribe,
    // Why: the web client has no native tray/menu bar, so it never queues an open-settings or quit request.
    consumePendingOpenSettings: () => Promise.resolve(false),
    onQuitAndStopAllSessions: () => noopUnsubscribe,
    consumePendingQuitAndStopAllSessions: () => Promise.resolve(false),
    ...WEB_PENDING_LINK_API,
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
    onOpenWorkspaceBoard: () => noopUnsubscribe,
    onToggleAgentDashboard: () => noopUnsubscribe,
    onJumpToWorktreeIndex: () => noopUnsubscribe,
    onJumpToTabIndex: () => noopUnsubscribe,
    onWorktreeHistoryNavigate: () => noopUnsubscribe,
    onRequestTabCreate: () => noopUnsubscribe,
    replyTabCreate: () => {},
    browserTabRequestsReady: () => {},
    onRequestRemoteCliBrowserScope: () => noopUnsubscribe,
    replyRemoteCliBrowserScope: () => {},
    onRequestTabSetProfile: () => noopUnsubscribe,
    replyTabSetProfile: () => {},
    onRequestTabClose: () => noopUnsubscribe,
    replyTabClose: () => {},
    onBrowserPageTabShortcut: () => noopUnsubscribe,
    onToggleProjectsCollapse: () => noopUnsubscribe,
    onFocusBrowserAddressBar: () => noopUnsubscribe,
    onShowBrowserHistory: () => noopUnsubscribe,
    onFindInBrowserPage: () => noopUnsubscribe,
    onReloadBrowserPage: () => noopUnsubscribe,
    onBrowserHistoryNavigate: () => noopUnsubscribe,
    onBrowserPagePointerDown: () => noopUnsubscribe,
    onZoomBrowserPage: () => noopUnsubscribe,
    onHardReloadBrowserPage: () => noopUnsubscribe,
    onCloseActiveTab: () => noopUnsubscribe,
    onCloseFloatingItem: () => noopUnsubscribe,
    onSelectFloatingIndex: () => noopUnsubscribe,
    onSwitchRecentTab: () => noopUnsubscribe,
    onCtrlTabKeyDown: () => noopUnsubscribe,
    onCtrlTabKeyUp: () => noopUnsubscribe,
    onToggleStatusBar: () => noopUnsubscribe,
    onDictationKeyDown: () => noopUnsubscribe,
    onActivateWorktree: () => noopUnsubscribe,
    onCreateTerminal: () => noopUnsubscribe,
    onRequestTerminalCreate: () => noopUnsubscribe,
    onRequestTerminalTabMount: () => noopUnsubscribe,
    replyTerminalCreate: () => {},
    onPublishAgentLaunchTab: () => noopUnsubscribe,
    onAgentLaunchPaneVerdict: () => noopUnsubscribe,
    onLaunchRecipe: () => noopUnsubscribe,
    replyAgentLaunchTabPublish: () => {},
    onRevealTerminalPane: () => noopUnsubscribe,
    replyTerminalPaneReveal: () => {},
    onApplyAgentPaneActivity: () => noopUnsubscribe,
    replyAgentPaneActivity: () => {},
    onSplitTerminal: () => noopUnsubscribe,
    onRenameTerminal: () => noopUnsubscribe,
    onSetPaneTitle: () => noopUnsubscribe,
    onFocusTerminal: () => noopUnsubscribe,
    onFocusEditorTab: () => noopUnsubscribe,
    onCloseSessionTab: () => noopUnsubscribe,
    onSessionTabCloseRequest: () => noopUnsubscribe,
    respondSessionTabClose: () => {},
    onMoveSessionTab: () => noopUnsubscribe,
    onOpenFileFromMobile: () => noopUnsubscribe,
    onRevealEditorTabFromRuntime: () => noopUnsubscribe,
    onOpenDiffFromMobile: () => noopUnsubscribe,
    onCloseTerminal: () => noopUnsubscribe,
    onTerminalTabCloseRequest: () => noopUnsubscribe,
    respondTerminalTabClose: () => {},
    onWorkspaceSleep: subscribeWebWorkspaceSleep,
    // Why: paired web is a full renderer that wakes on activation; mobile wake is desktop-host-scoped and never reaches web.
    onResumeSleepingAgents: () => noopUnsubscribe,
    onSleepingMailChanged: () => noopUnsubscribe,
    replySleepingAgentWake: () => {},
    notifySleepingMailAvailability: () => {},
    requestSleepingMailSnapshot: () => {},
    onTerminalZoom: () => noopUnsubscribe,
    ...createWebUiNativeWindowApi()
  }
}
