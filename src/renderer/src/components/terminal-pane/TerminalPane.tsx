/* eslint-disable max-lines -- Why: terminal pane component co-locates title state, layout serialization, and portal rendering to keep pane lifecycle consistent. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { IDisposable } from '@xterm/xterm'
import { useAppStore } from '../../store'
import { isUnifiedTabPinned } from '@/store/pinned-tab-close-guard'
import { useLinkRoutingPreferenceDialog } from '@/components/link-routing-preference-dialog'
import { DaemonActionDialog, useDaemonActions } from '@/components/shared/useDaemonActions'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  isTerminalBackgroundLight,
  normalizeColor,
  resolveOpaqueTerminalBackground,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import type {
  ManagedPane,
  PaneExternalDropTarget,
  PaneManager
} from '@/lib/pane-manager/pane-manager'
import TerminalSearch from '@/components/TerminalSearch'
import type { PtyTransport } from './pty-transport'
import { fitPanes, isWindowsUserAgent } from './pane-helpers'
import { getConnectionId, getConnectionIdFromState } from '@/lib/connection-context'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import {
  selectRuntimeAwareSshStatus,
  selectRuntimeAwareSshTargetLabel,
  selectRuntimeAwareSshTargetRemoved
} from '@/store/slices/runtime-environment-ssh'
import { hydrateRuntimeEnvironmentSshState } from '@/runtime/runtime-environment-ssh-state'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { handleInternalTerminalFileDrop } from './terminal-drop-handler'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import {
  collectLeafIdsInOrder,
  EMPTY_LAYOUT,
  serializeTerminalLayout
} from './layout-serialization'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import {
  applyExpandedLayoutTo,
  cancelPendingPaneSizeRefreshFrames,
  createExpandCollapseActions,
  restoreExpandedLayoutFrom
} from './expand-collapse'
import { useTerminalKeyboardShortcuts, type SearchState } from './keyboard-handlers'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { useTerminalFontZoom } from './useTerminalFontZoom'
import CloseTerminalDialog, { type CloseTerminalDialogCopyKind } from './CloseTerminalDialog'
import { MobileDriverOverlay } from './MobileDriverOverlay'
import { TerminalErrorToast } from './TerminalErrorToast'
import { TerminalSessionStateSaveFailureDialog } from './TerminalSessionStateSaveFailureDialog'
import TerminalContextMenu from './TerminalContextMenu'
import TerminalPaneHeaderOverlay from './TerminalPaneHeaderOverlay'
import NativeChatView from '../native-chat/NativeChatView'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'
import { TerminalAgentSessionForkDialog } from './TerminalAgentSessionForkDialog'
import { SessionRestoredBannerPortals } from './SessionRestoredBannerPortals'
import { useSessionRestoredBannerDismiss } from './useSessionRestoredBannerDismiss'
import {
  addSessionRestoredBannerPaneId,
  dismissSessionRestoredBannerPaneIds,
  pruneSessionRestoredBannerPaneIds,
  removeSessionRestoredBannerPaneId,
  syncSessionRestoredBannerTitleSpace,
  type SessionRestoredBannerDismissEvent
} from './session-restored-banner-pane-state'
import { useSystemPrefersDark } from './use-system-prefers-dark'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { useTerminalPaneLifecycle } from './use-terminal-pane-lifecycle'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'
import {
  detachTerminalPaneToTab,
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget
} from './terminal-pane-tab-detach'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'
import { useNotificationDispatch } from './use-notification-dispatch'
import { connectPanePty } from './pty-connection'
import { resolveTerminalLayoutActiveLeafId } from './terminal-layout-leaf-ids'
import { shouldPreserveTerminalScrollbackBuffers } from '../../../../shared/workspace-session-terminal-buffers'
import {
  getMobileFitOverridePtyIds,
  getFitOverrideForPty,
  onOverrideChange
} from '@/lib/pane-manager/mobile-fit-overrides'
import { shouldShowMobileDriverOverlay } from './mobile-driver-overlay-visibility'
import {
  getAllDrivers,
  getDriverForPty,
  isPtyLocked,
  onDriverChange
} from '@/lib/pane-manager/mobile-driver-state'
import { shouldChatTakeOverMobileSurface } from '../native-chat/native-chat-send-eligibility'
import { canToggleNativeChat } from '../native-chat/native-chat-availability'
import {
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatLeafRoute
} from '../native-chat/native-chat-leaf-routing'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { resolvePaneKeyForManager } from '@/lib/pane-manager/pane-key-resolution'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { captureTerminalShutdownLayout } from './terminal-shutdown-layout-capture'
import { getOverrideAffectedPanes, getPanesNeedingOverrideFit } from './override-affected-panes'
import {
  inspectRuntimeTerminalProcess,
  isRemoteRuntimePtyId
} from '@/runtime/runtime-terminal-inspection'
import {
  clearWebRuntimeTerminalBuffer,
  closeWebRuntimeTerminal,
  updateWebRuntimePaneLayout
} from '@/runtime/web-runtime-session'
import { isPrimarySelectionEnabled, readPrimarySelectionText } from '@/lib/primary-selection'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { WORKSPACE_FILE_PATH_MIME, WORKSPACE_FILE_PATHS_MIME } from '@/lib/workspace-file-drag'
import { isTerminalSessionStateSaveFailure } from '../../../../shared/terminal-session-state-save-failure'
import { isTerminalZeroDimensionsDiagnostic } from '../../../../shared/terminal-zero-dimensions-diagnostic'
import {
  isSyntheticSinglePaneTitle,
  sanitizeTerminalLayoutPaneTitles
} from '@/lib/terminal-pane-title-sanitization'
import {
  isHostAuthoritativeLayout,
  planTerminalLiveLayoutInsertions
} from './terminal-live-layout-reconciliation'
import type { TerminalQuickCommand, TerminalQuickCommandScope } from '../../../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import { refitAndRefreshAllTerminalPanes } from '@/lib/pane-manager/pane-manager-registry'
import {
  getTerminalQuickCommandScope,
  isTerminalQuickCommandComplete,
  terminalQuickCommandMatchesRepo
} from '../../../../shared/terminal-quick-commands'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { pasteTerminalClipboard } from './terminal-clipboard-paste'
import { scheduleImagePasteWebglAtlasRecovery } from './terminal-webgl-atlas-recovery'
import { restoreTerminalFitToDesktop, restoreTerminalFitsToDesktop } from './terminal-fit-restore'
import { useVisibleTerminalTabClaim } from './use-visible-terminal-tab-claim'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import { selectTerminalTabAgentTypesByLeaf } from './terminal-tab-agent-type-index'

const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'

function isInsideNativeChatRoot(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NATIVE_CHAT_ROOT_SELECTOR) !== null
}

// Why: registry lives in a leaf module so the store slice can import it
// without re-entering the `slice → TerminalPane → store → slice` cycle
// that otherwise leaves createTerminalSlice undefined at store-init time.
import { shutdownBufferCaptures } from './shutdown-buffer-captures'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'
import { pasteTerminalText } from './terminal-bracketed-paste'
import {
  executeTerminalPastePlan,
  planTerminalPasteWithYield,
  type TerminalPasteSource,
  type TerminalPasteTextOptions
} from './terminal-paste-coordinator'
import { formatTerminalPasteExecutionError } from './terminal-paste-errors'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import {
  isTerminalPanePasteFocusCurrent,
  isTerminalPanePasteTargetCurrent
} from './terminal-paste-target-state'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import {
  applyTerminalPaneAttentionToManager,
  subscribeTerminalPaneAttention
} from './terminal-pane-attention-subscriptions'
import { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'
import {
  getCachedTerminalGroupIdForWorktree,
  getCachedUnifiedTerminalTabForWorktree
} from './terminal-unified-tab-lookup'
import { resolveNativeChatLeafTitleAgent } from './native-chat-leaf-title-agent'
import { useRepoById } from '@/store/selectors'
import {
  isXtermHelperTextarea,
  releaseTerminalFocusForOutsidePointerDown,
  releaseTerminalFocusForWindowBlur,
  resyncTerminalFocusForWindowFocus,
  setRegularTerminalInputFocusAttribute
} from './regular-terminal-focus-ownership'
import { refreshTerminalImeInputContext } from './terminal-ime-input-context-refresh'

type TerminalPaneProps = {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  isVisible?: boolean
  isWorktreeActive?: boolean
  // Why: when set (Activity portal), this pane visually isolates the given
  // split pane so only that leaf is shown. Implemented as a transient layout
  // override (separate snapshot ref) — does NOT touch expandedPaneId state
  // or persist to the layout snapshot, so returning to the workspace shows
  // the original split layout unchanged.
  isolatedPaneKey?: string | null
  onPtyExit: (ptyId: string) => void
  onCloseTab: () => void
}

type PaneTitleOverlayRect = {
  left: number
  top: number
  width: number
}

type TerminalQuickCommandEditorDialogProps = {
  command: TerminalQuickCommand
  onOpenChange: (open: boolean) => void
  onSave: (command: TerminalQuickCommand) => void
}

function TerminalQuickCommandEditorDialog({
  command,
  onOpenChange,
  onSave
}: TerminalQuickCommandEditorDialogProps): React.JSX.Element {
  const repos = useAppStore((store) => store.repos)

  return (
    <TerminalQuickCommandDialog
      open
      mode="add"
      command={command}
      repos={repos}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  )
}

function formatClipboardImagePasteError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Image paste failed: ${detail}`
}

function arePaneTitleOverlayRectsEqual(
  a: Record<number, PaneTitleOverlayRect>,
  b: Record<number, PaneTitleOverlayRect>
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) {
    return false
  }
  return aKeys.every((key) => {
    const paneId = Number(key)
    const left = Math.abs((a[paneId]?.left ?? 0) - (b[paneId]?.left ?? 0))
    const top = Math.abs((a[paneId]?.top ?? 0) - (b[paneId]?.top ?? 0))
    const width = Math.abs((a[paneId]?.width ?? 0) - (b[paneId]?.width ?? 0))
    return left < 0.5 && top < 0.5 && width < 0.5
  })
}

export default function TerminalPane({
  tabId,
  worktreeId,
  cwd,
  isActive,
  isVisible = true,
  isWorktreeActive = isVisible,
  isolatedPaneKey = null,
  onPtyExit,
  onCloseTab
}: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const managerRef = useRef<PaneManager | null>(null)
  const paneFontSizesRef = useRef<Map<number, number>>(new Map())
  const expandedPaneIdRef = useRef<number | null>(null)
  const expandedStyleSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const pendingPaneSizeRefreshFrameIdsRef = useRef<number[]>([])
  // Why (separate from expandedStyleSnapshotRef): Activity isolation is a
  // transient view override that must not collide with the user-facing
  // expanded-pane state or the layout snapshot. Keeping its own snapshot
  // map means applyExpandedLayoutTo's internal restore (which targets the
  // ref it was passed) only clears Activity's overlay, not the user's.
  const activityIsolationSnapshotRef = useRef<Map<HTMLElement, { display: string; flex: string }>>(
    new Map()
  )
  const paneTransportsRef = useRef<Map<number, PtyTransport>>(new Map())
  // Why: per-pane live cwd tracked via OSC 7 for split-pane cwd inheritance.
  // See docs/ssh-split-pane-inherit-cwd.md. The OSC 7 handler is installed
  // in use-terminal-pane-lifecycle; keyboard and context-menu split actions
  // read this map at dispatch time to pass cwd into splitPane.
  const paneCwdRef = useRef<Map<number, { cwd: string; confirmed: boolean }>>(new Map())
  const paneMode2031Ref = useRef<Map<number, boolean>>(new Map())
  // Why: per-pane mirror of the kitty keyboard flags negotiated by the pane's
  // application (fed from PTY output in pty-connection). The keyboard policy
  // reads it to encode Option chords as kitty CSI-u for opted-in TUIs.
  const paneKittyKeyboardModesRef = useRef<Map<number, TerminalKittyKeyboardModeTracker>>(new Map())
  const paneLastThemeModeRef = useRef<Map<number, 'dark' | 'light'>>(new Map())
  const panePtyBindingsRef = useRef<Map<number, IDisposable>>(new Map())
  // Why: tracks panes currently replaying recorded PTY bytes into xterm
  // (cold-restore, daemon snapshot, scrollback restore, eager-buffer flush).
  // While non-zero, pty-connection.ts drops xterm onData so auto-replies to
  // embedded query sequences don't leak to the shell. See replay-guard.ts.
  const replayingPanesRef = useRef<Map<number, number>>(new Map())
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const isRendererVisible = isVisible && isWorktreeActive
  const isVisibleRef = useRef(isRendererVisible)
  isVisibleRef.current = isRendererVisible
  const sshReconnectTargetId = useAppStore((store) => {
    const connectionId = getConnectionIdFromState(store, worktreeId)
    // Why: runtime-owned SSH targets are internal plumbing users can't connect
    // to directly, so a reconnect prompt would offer a misleading action.
    if (!connectionId || isRuntimeOwnedSshTargetId(connectionId)) {
      return null
    }
    return connectionId
  })
  const nativeChatTranscriptIsLocalReadable = useAppStore((store) =>
    isNativeChatTranscriptLocalReadable(getConnectionIdFromState(store, worktreeId))
  )
  // Which machine's SSH store this target belongs to: a remote Orca server's
  // per-environment bucket, or null for this machine's local SSH maps. The
  // explicit-owner resolver never lets a merely focused runtime make a
  // local-owned workspace look remote. The paired web client mirrors its one
  // host through the local maps instead.
  const sshReconnectEnvironmentId = useAppStore((store) =>
    sshReconnectTargetId && !isPairedWebClientWindow()
      ? getExplicitRuntimeEnvironmentIdForWorktree(store, worktreeId)
      : null
  )
  const sshReconnectStatus = useAppStore((store) =>
    sshReconnectTargetId
      ? selectRuntimeAwareSshStatus(store, sshReconnectEnvironmentId, sshReconnectTargetId)
      : null
  )
  const sshReconnectTargetLabel = useAppStore((store) =>
    sshReconnectTargetId
      ? selectRuntimeAwareSshTargetLabel(store, sshReconnectEnvironmentId, sshReconnectTargetId)
      : ''
  )
  // Why: the target was removed entirely (a ghost) when it's no longer a known
  // SSH target on its owning host. Reconnecting to it can only fail ("SSH
  // target not found"), so the overlay must offer to remove the workspace
  // instead of Connect. The selector requires positive removal evidence.
  const sshReconnectTargetRemoved = useAppStore((store) =>
    sshReconnectTargetId
      ? selectRuntimeAwareSshTargetRemoved(store, sshReconnectEnvironmentId, sshReconnectTargetId)
      : false
  )
  useEffect(() => {
    if (!sshReconnectEnvironmentId) {
      return
    }
    // Why: an SSH-backed workspace can be mirrored before its owning
    // environment's bucket ever hydrated (no-op once hydrated), and overlay
    // state must come from fetched evidence, never from an empty default.
    void hydrateRuntimeEnvironmentSshState(sshReconnectEnvironmentId).catch(() => {})
  }, [sshReconnectEnvironmentId])

  useVisibleTerminalTabClaim({ isVisible, tabId })

  const [expandedPaneId, setExpandedPaneId] = useState<number | null>(null)
  // Why: tracked in React state (not derived from managerRef.getPanes().length)
  // so the render containing the portal map (which reads the imperative pane
  // list via managerRef.current?.getPanes()) re-runs when a pane is split or
  // closed. managerRef is imperative and doesn't trigger React's dependency
  // tracking. The lifecycle hook updates this via setPaneCount on
  // onPaneCreated / onPaneClosed / onLayoutChanged. The portal map reads the
  // manager imperatively; the count also wakes leaf-ownership initialization.
  const [paneCount, setPaneCount] = useState<number>(0)
  // Why: pane reorders can move panes without changing count or size, so
  // overlay rects need an explicit layout-change render trigger.
  const [paneLayoutRevision, setPaneLayoutRevision] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(false)
  searchOpenRef.current = searchOpen
  const searchStateRef = useRef<SearchState>({ query: '', caseSensitive: false, regex: false })
  const [pendingCloseConfirmation, setPendingCloseConfirmation] = useState<{
    paneId: number
    copyKind: CloseTerminalDialogCopyKind
  } | null>(null)
  const [quickCommandEditorOpen, setQuickCommandEditorOpen] = useState(false)
  const [chatLeafId, setChatLeafId] = useState<string | null>(null)
  const [tabWideAgentHintLeafId, setTabWideAgentHintLeafId] = useState<string | null | undefined>(
    undefined
  )
  // Why: the terminal menu can be the first quick-command entry point, so each
  // Add action starts with a fresh draft instead of reusing cancelled text.
  const [quickCommandDraft, setQuickCommandDraft] = useState(createTerminalQuickCommandDraft)
  const [agentSessionFork, setAgentSessionFork] = useState<PreparedAgentSessionFork | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const [sessionStateSaveFailureOpen, setSessionStateSaveFailureOpen] = useState(false)
  const daemonActions = useDaemonActions()
  // Why: override state lives in a plain Map for perf (safeFit reads it on
  // every resize). This counter forces a re-render when overrides change so
  // the mobile-fit banner appears/disappears. On both transitions we also
  // trigger safeFit on affected panes: mobile-fit shrinks the watcher's xterm
  // to phone dims (matching the live phone-wrapped stream), and desktop-fit
  // resizes back to desktop dimensions.
  const [, setOverrideTick] = useState(0)
  useEffect(() => {
    const pendingFitFrames = new Set<number>()
    const pendingFallbackTimers = new Set<number>()

    const scheduleFitFrame = (callback: () => void): void => {
      const frameId = window.requestAnimationFrame(() => {
        pendingFitFrames.delete(frameId)
        callback()
      })
      pendingFitFrames.add(frameId)
    }

    const scheduleFallbackTimer = (callback: () => void): void => {
      const timerId = window.setTimeout(() => {
        pendingFallbackTimers.delete(timerId)
        callback()
      }, 100)
      pendingFallbackTimers.add(timerId)
    }

    const unsubscribe = onOverrideChange((event) => {
      setOverrideTick((n) => n + 1)
      const manager = managerRef.current
      if (!manager) {
        return
      }
      // Why: pane IDs are per-tab, so resolve the affected PTY through this
      // tab's live transport bindings instead of global numeric pane IDs.
      const getAffectedPanes = (): ReturnType<typeof manager.getPanes> =>
        getOverrideAffectedPanes(
          manager.getPanes(),
          (paneId) => paneTransportsRef.current.get(paneId)?.getPtyId(),
          event.ptyId
        )
      if (event.mode === 'mobile-fit' || event.mode === 'remote-desktop-fit') {
        // Why: when mobile starts driving, the agent re-renders its output at
        // phone width and that phone-wrapped byte stream flows live into this
        // passive watcher's xterm. xterm must shrink to the phone dims now or
        // the wide desktop grid renders the narrow stream as overlapping,
        // garbled lines. safeFit honors the active override and parks xterm at
        // override.cols/rows, matching the incoming stream. rAF lets the DOM
        // settle before the resize; no loud fallback is needed because the
        // override branch of safeFit is itself the authoritative resize.
        // Why: override events fan out to every terminal tab; skip the rAF
        // unless this tab has a pane still parked at the wrong grid.
        const panesNeedingFit = getPanesNeedingOverrideFit(
          getAffectedPanes(),
          event.cols,
          event.rows
        )
        if (panesNeedingFit.length === 0) {
          return
        }
        scheduleFitFrame(() => {
          for (const pane of getPanesNeedingOverrideFit(
            getAffectedPanes(),
            event.cols,
            event.rows
          )) {
            safeFit(pane)
          }
        })
        return
      }
      if (event.mode === 'desktop-fit') {
        // Why: fitAddon.fit() measures DOM dimensions, so it must run after
        // the browser has settled layout. Running synchronously inside the
        // IPC callback can produce stale measurements. rAF ensures the DOM
        // is ready. The follow-up timeout acts as a safety net: if
        // fitAddon.fit() silently threw (its errors are caught), the timeout
        // falls back to a direct terminal.resize() using the restored
        // dimensions from the runtime. This guarantees xterm exits mobile
        // dims even when the DOM-based fit path fails.
        const fitAffectedPanes = (): void => {
          for (const pane of getAffectedPanes()) {
            safeFit(pane)
          }
        }
        scheduleFitFrame(fitAffectedPanes)
        // Why: belt-and-suspenders — if safeFit's fitAddon.fit() threw or
        // was a no-op due to stale dimensions, fall back to a direct
        // resize. ONLY fire if xterm is still parked at the prior
        // mobile-fit dims, meaning safeFit failed to move it. Previously
        // we also fired when xterm had moved to *any* size other than
        // the captured baseline, which clobbered safeFit's correct
        // DOM-measured fit when the desktop pane geometry had changed
        // since mobile-fit started (e.g. user closed a split or resized
        // the window while the phone was active). In that scenario the
        // event.cols/rows is the stale baseline from the moment
        // mobile-fit started, not the current pane geometry — applying
        // it would shrink the terminal back to e.g. half-width.
        scheduleFallbackTimer(() => {
          for (const pane of getAffectedPanes()) {
            // Why: skip the fallback for hidden/unmounted panes whose
            // container is 0×0. Force-resizing xterm to the server's
            // desktop dims while the DOM has no geometry leaves xterm
            // with cols/rows that won't match when the tab is later
            // activated (the activation refit will correct it). The
            // fallback is for the *visible* pane that legitimately
            // failed to refit via the rAF safeFit.
            const rect = pane.container.getBoundingClientRect()
            if (rect.width === 0 || rect.height === 0) {
              continue
            }
            safeFit(pane)
            const stuckAtMobile =
              event.priorCols != null &&
              event.priorRows != null &&
              pane.terminal.cols === event.priorCols &&
              pane.terminal.rows === event.priorRows
            if (stuckAtMobile && event.cols > 0 && event.rows > 0) {
              pane.terminal.resize(event.cols, event.rows)
            }
          }
        })
      }
    })

    return () => {
      unsubscribe()
      for (const frameId of pendingFitFrames) {
        window.cancelAnimationFrame(frameId)
      }
      pendingFitFrames.clear()
      for (const timerId of pendingFallbackTimers) {
        window.clearTimeout(timerId)
      }
      pendingFallbackTimers.clear()
    }
  }, [])

  // Why: presence-lock banner re-render. Driver state lives in a plain Map
  // for perf; this counter forces a re-render when the driver flips so the
  // lock banner appears/disappears. See docs/mobile-presence-lock.md.
  const [, setDriverTick] = useState(0)
  useEffect(
    () =>
      onDriverChange(() => {
        setDriverTick((n) => n + 1)
      }),
    []
  )

  // Pane title state — keyed by ephemeral paneId, persisted via titlesByLeafId
  // in the layout snapshot. Ref keeps persistLayoutSnapshot closures fresh.
  const [paneTitles, setPaneTitles] = useState<Record<number, string>>({})
  const paneTitlesRef = useRef<Record<number, string>>({})
  paneTitlesRef.current = paneTitles
  const removedTitleLeafIdsRef = useRef<Set<string>>(new Set())
  const clearedScrollbackLeafIdsRef = useRef<Set<string>>(new Set())
  const [paneTitleOverlayRects, setPaneTitleOverlayRects] = useState<
    Record<number, PaneTitleOverlayRect>
  >({})
  const [renamingPaneId, setRenamingPaneId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  // Guard against double-submit: when the user presses Enter, handleRenameSubmit
  // runs and then the input unmounts causing onBlur to fire handleRenameSubmit
  // again. Similarly, pressing Escape runs handleRenameCancel but blur would
  // then call handleRenameSubmit, saving the title the user wanted to discard.
  const renameSubmittedRef = useRef(false)
  const renameSessionIdRef = useRef(0)
  const renameBlurCommitEnabledRef = useRef(true)
  // Why: delayed xterm/Radix focus handoffs look like blur but are not user
  // intent. Only outside pointer/Tab navigation should make blur commit.
  const renameUserRequestedBlurCommitRef = useRef(false)
  const renameFocusFrameRef = useRef<number | null>(null)
  const renameEnableBlurFrameRef = useRef<number | null>(null)
  const renameRefocusFrameRef = useRef<number | null>(null)
  /**
   * Cancels deferred focus/blur work from inline title editing.
   * Rename sessions schedule multiple frames because xterm and Radix can both
   * move focus after the menu closes.
   */
  const cancelPendingRenameFrames = useCallback(() => {
    const frameRefs = [renameFocusFrameRef, renameEnableBlurFrameRef, renameRefocusFrameRef]
    for (const frameRef of frameRefs) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  /**
   * Invalidates the active inline title edit session before unmount or cancel.
   * Session IDs keep stale animation-frame callbacks from committing old titles.
   */
  const closeRenameSession = useCallback(() => {
    renameSessionIdRef.current += 1
    renameBlurCommitEnabledRef.current = true
    renameUserRequestedBlurCommitRef.current = false
    cancelPendingRenameFrames()
  }, [cancelPendingRenameFrames])

  /**
   * Owns the terminal container ref and closes rename work when that owner
   * detaches, preventing delayed focus callbacks from targeting stale DOM.
   */
  const setContainerRef = useCallback(
    (node: HTMLDivElement | null): void => {
      containerRef.current = node
      if (node !== null) {
        return
      }
      // Why: inline title rename focus/blur frames are owned by the terminal
      // container; invalidate them when that DOM owner detaches.
      closeRenameSession()
    },
    [closeRenameSession]
  )

  /**
   * Starts inline title editing from either the context menu or keyboard
   * shortcut while resetting stale blur-submit state from prior sessions.
   */
  const handleStartRename = useCallback(
    (paneId: number) => {
      cancelPendingRenameFrames()
      renameSessionIdRef.current += 1
      renameBlurCommitEnabledRef.current = false
      renameUserRequestedBlurCommitRef.current = false
      renameSubmittedRef.current = false
      setRenameValue(paneTitlesRef.current[paneId] ?? '')
      setRenamingPaneId(paneId)
    },
    [cancelPendingRenameFrames]
  )
  const onPtyErrorRef = useRef((_paneId: number, message: string) => {
    if (isTerminalSessionStateSaveFailure(message)) {
      setTerminalError(null)
      setSessionStateSaveFailureOpen(true)
      return
    }
    setTerminalError((prev) => (prev ? `${prev}\n${message}` : message))
  })

  const setTabPaneExpanded = useAppStore((store) => store.setTabPaneExpanded)
  const setTabCanExpandPane = useAppStore((store) => store.setTabCanExpandPane)
  const suppressPtyExit = useAppStore((store) => store.suppressPtyExit)
  const pendingCodexPaneRestartIds = useAppStore((store) => store.pendingCodexPaneRestartIds)
  const consumePendingCodexPaneRestart = useAppStore(
    (store) => store.consumePendingCodexPaneRestart
  )
  const clearCodexRestartNotice = useAppStore((store) => store.clearCodexRestartNotice)
  // Why: when this tab is in native chat view the chat surface is the active
  // layer above the still-mounted terminal, so the terminal's own mobile-driver
  // overlay must not render on top of it; the chat composer's guarded canSend
  // communicates the presence-lock inside the chat surface instead (U9/R8).
  const unifiedTabId = useAppStore(
    (store) =>
      getCachedUnifiedTerminalTabForWorktree(store.unifiedTabsByWorktree, worktreeId, tabId)?.id
  )
  const isChatViewMode = useAppStore(
    (store) =>
      getCachedUnifiedTerminalTabForWorktree(store.unifiedTabsByWorktree, worktreeId, tabId)
        ?.viewMode === 'chat'
  )
  const nativeChatEnabled = useAppStore((store) => store.settings?.experimentalNativeChat === true)
  const effectiveChatViewMode = nativeChatEnabled && isChatViewMode
  const unifiedTabLabel = useAppStore(
    (store) =>
      getCachedUnifiedTerminalTabForWorktree(store.unifiedTabsByWorktree, worktreeId, tabId)?.label
  )
  const runtimePaneTitlesByPaneId = useAppStore(
    useShallow((store) => store.runtimePaneTitlesByTabId[tabId] ?? {})
  )
  // The native-chat toggle joins the pane header's split/close cluster. Eligible
  // when Orca launched a *supported* agent here or one was detected live for the
  // leaf, keyed `${tabId}:${leafId}`. Carry the agent identity, not just "an
  // agent exists", so the gate can reject Grok et al.
  // Scope to this tab's panes and reuse the shared map index so hidden tabs do
  // not each rescan every agent entry on unrelated store writes.
  const tabAgentTypeByLeaf = useAppStore((store) =>
    selectTerminalTabAgentTypesByLeaf(store.agentStatusByPaneKey, tabId)
  )
  const toggleTabViewMode = useAppStore((store) => store.toggleTabViewMode)
  const setTabViewMode = useAppStore((store) => store.setTabViewMode)
  const savedLayout = useAppStore((store) => store.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
  const terminalTab = useAppStore((store) =>
    getCachedTerminalTabForWorktree(store.tabsByWorktree, worktreeId, tabId)
  )
  const restoredLayout = useMemo(
    () => (terminalTab ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab) : savedLayout),
    [savedLayout, terminalTab]
  )
  const expectedLayoutLeafIds = useMemo(
    () => collectLeafIdsInOrder(restoredLayout.root),
    [restoredLayout.root]
  )
  const getNativeChatLeafIds = useCallback((): string[] => {
    const mountedLeafIds = managerRef.current?.getPanes().map((pane) => pane.leafId) ?? []
    // Why: a partially hydrated manager can expose one pane from a restored
    // split. Union both sources so tab-wide evidence stays disabled meanwhile.
    return [...new Set([...expectedLayoutLeafIds, ...mountedLeafIds])]
  }, [expectedLayoutLeafIds])
  const getTabWideAgentHintLeafId = useCallback((): string | null => {
    if (tabWideAgentHintLeafId !== undefined) {
      return tabWideAgentHintLeafId
    }
    const leafIds = getNativeChatLeafIds()
    return leafIds.length === 1 ? leafIds[0] : null
  }, [getNativeChatLeafIds, tabWideAgentHintLeafId])
  useEffect(() => {
    if (tabWideAgentHintLeafId !== undefined) {
      return
    }
    const leafIds = getNativeChatLeafIds()
    if (leafIds.length === 0) {
      return
    }
    // Why: tab-wide launch/title metadata predates leaf ownership. Bind it only
    // when the first concrete topology proves which sole leaf it can describe.
    setTabWideAgentHintLeafId(leafIds.length === 1 ? leafIds[0] : null)
  }, [getNativeChatLeafIds, paneCount, tabWideAgentHintLeafId])
  const resolveTitleAgentForLeaf = useCallback(
    (leafId: string | null) => {
      const hasSingleKnownLeaf =
        getNativeChatLeafIds().length === 1 && getTabWideAgentHintLeafId() === leafId
      return resolveNativeChatLeafTitleAgent({
        leafId,
        panes: managerRef.current?.getPanes() ?? [],
        runtimePaneTitlesByPaneId,
        tabLabel: hasSingleKnownLeaf ? unifiedTabLabel : null,
        terminalTitle: hasSingleKnownLeaf ? terminalTab?.title : null
      })
    },
    [
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      runtimePaneTitlesByPaneId,
      terminalTab?.title,
      unifiedTabLabel
    ]
  )
  // Per-leaf eligibility: a split can mix a supported agent in one leaf with an
  // unsupported one in another, so the toggle is gated by the specific leaf.
  // A leaf's own live agent is authoritative; the tab-wide launch/title hints
  // only fill in before hooks arrive (or for the single-pane case) so they
  // can't enable the toggle on a sibling actually running an unsupported agent.
  const isChatEligibleForLeaf = useCallback(
    (leafId: string | null): boolean => {
      const detectedAgent = leafId ? (tabAgentTypeByLeaf[leafId] ?? null) : null
      const launchAgent = nativeChatLaunchAgentForLeaf({
        launchAgent: terminalTab?.launchAgent,
        launchAgentLeafId: getTabWideAgentHintLeafId(),
        leafId,
        leafIds: getNativeChatLeafIds()
      })
      return canToggleNativeChat({
        experimentalNativeChatEnabled: nativeChatEnabled,
        contentType: 'terminal',
        launchAgent: detectedAgent ? null : launchAgent,
        detectedAgent,
        resolvedAgent: detectedAgent ? null : resolveTitleAgentForLeaf(leafId),
        nativeChatTranscriptIsLocalReadable
      })
    },
    [
      tabAgentTypeByLeaf,
      nativeChatEnabled,
      nativeChatTranscriptIsLocalReadable,
      terminalTab?.launchAgent,
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      resolveTitleAgentForLeaf
    ]
  )
  const canToggleChatForLeaf = useCallback(
    (leafId: string | null): boolean => {
      // Scope the "always allow toggling back" rule to the leaf actually showing
      // chat; it must not make an unsupported sibling look eligible.
      const isChatViewForLeaf = effectiveChatViewMode && leafId !== null && chatLeafId === leafId
      return (nativeChatEnabled && isChatViewForLeaf) || isChatEligibleForLeaf(leafId)
    },
    [chatLeafId, effectiveChatViewMode, isChatEligibleForLeaf, nativeChatEnabled]
  )
  const toggleNativeChatForLeaf = useCallback(
    (leafId: string) => {
      if (!unifiedTabId) {
        return
      }
      if (effectiveChatViewMode && chatLeafId === leafId) {
        setChatLeafId(null)
        toggleTabViewMode(unifiedTabId)
        return
      }
      setChatLeafId(leafId)
      if (!effectiveChatViewMode) {
        toggleTabViewMode(unifiedTabId)
      }
    },
    [unifiedTabId, effectiveChatViewMode, chatLeafId, toggleTabViewMode]
  )
  const handleToggleNativeChat = useCallback(() => {
    const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
    if (!activeLeafId) {
      return
    }
    toggleNativeChatForLeaf(activeLeafId)
  }, [toggleNativeChatForLeaf])
  const setTabLayout = useAppStore((store) => store.setTabLayout)
  const expectedLayoutLeafIdsAttr =
    expectedLayoutLeafIds.length > 0 ? expectedLayoutLeafIds.join(' ') : undefined
  const initialLayoutRef = useRef(restoredLayout)
  const updateTabTitle = useAppStore((store) => store.updateTabTitle)
  const setRuntimePaneTitle = useAppStore((store) => store.setRuntimePaneTitle)
  const clearRuntimePaneTitle = useAppStore((store) => store.clearRuntimePaneTitle)
  const updateTabPtyId = useAppStore((store) => store.updateTabPtyId)
  const clearTabPtyId = useAppStore((store) => store.clearTabPtyId)
  const markWorktreeUnread = useAppStore((store) => store.markWorktreeUnread)
  const markTerminalTabUnread = useAppStore((store) => store.markTerminalTabUnread)
  const markTerminalPaneUnread = useAppStore((store) => store.markTerminalPaneUnread)
  const clearWorktreeUnread = useAppStore((store) => store.clearWorktreeUnread)
  const clearTerminalTabUnread = useAppStore((store) => store.clearTerminalTabUnread)
  const clearTerminalPaneUnread = useAppStore((store) => store.clearTerminalPaneUnread)
  const openSpacePage = useAppStore((store) => store.openSpacePage)
  const refreshWorkspaceSpace = useAppStore((store) => store.refreshWorkspaceSpace)
  const settings = useAppStore((store) => store.settings)
  const updateSettings = useAppStore((store) => store.updateSettings)
  const requestLinkRoutingPreference = useLinkRoutingPreferenceDialog()
  const keybindings = useAppStore((store) => store.keybindings)
  const rightClickToPaste = settings?.terminalRightClickToPaste ?? isWindowsUserAgent()
  // Why: Windows ConPTY does not forward DECSET 2004 from foreground TUIs, so
  // xterm may not know multi-line text needs bracketed-paste protection.
  const forceBracketedMultilineTextPaste = isWindowsUserAgent()
  const [startup] = useState(() => useAppStore.getState().pendingStartupByTabId[tabId])
  const [shouldMeasureHiddenStartup, setShouldMeasureHiddenStartup] = useState(
    () => startup !== undefined && !isVisible
  )
  const [sessionRestoredBannerPaneIds, setSessionRestoredBannerPaneIds] = useState<Set<number>>(
    () => new Set()
  )
  const consumeTabStartupCommand = useAppStore((store) => store.consumeTabStartupCommand)
  const [setupSplit] = useState(() => useAppStore.getState().pendingSetupSplitByTabId[tabId])
  const consumeTabSetupSplit = useAppStore((store) => store.consumeTabSetupSplit)
  const [issueCommandSplit] = useState(
    () => useAppStore.getState().pendingIssueCommandSplitByTabId[tabId]
  )
  const consumeTabIssueCommandSplit = useAppStore((store) => store.consumeTabIssueCommandSplit)
  useEffect(() => {
    if (startup) {
      consumeTabStartupCommand(tabId)
    }
  }, [startup, tabId, consumeTabStartupCommand])

  useLayoutEffect(() => {
    if (isVisible && shouldMeasureHiddenStartup) {
      // Why: hidden startup measurement is only for first launch. Keeping it
      // after first visibility lets inactive agent tabs refit and SIGWINCH.
      setShouldMeasureHiddenStartup(false)
    }
    if (isVisible) {
      // Why: a hidden pane that connected at 0×0 self-heals via the pane resize
      // observer once shown, so clear that stale diagnostic. Scoped to the
      // zero-dimensions message so genuine paste/save-failure errors survive.
      setTerminalError((prev) => (prev && isTerminalZeroDimensionsDiagnostic(prev) ? null : prev))
    }
  }, [isVisible, shouldMeasureHiddenStartup])

  const clearSessionRestoredBannerForPane = useCallback((paneId: number): void => {
    setSessionRestoredBannerPaneIds((prev) => {
      const next = removeSessionRestoredBannerPaneId(prev, paneId)
      return next === prev ? prev : next
    })
  }, [])

  const showRestoredSessionBanner = useCallback((paneId: number): void => {
    setSessionRestoredBannerPaneIds((prev) => {
      const next = addSessionRestoredBannerPaneId(prev, paneId)
      return next === prev ? prev : next
    })
  }, [])

  const dismissSessionRestoredBanner = useCallback(
    (event: SessionRestoredBannerDismissEvent): void => {
      setSessionRestoredBannerPaneIds((prev) =>
        dismissSessionRestoredBannerPaneIds(prev, event, managerRef.current?.getPanes() ?? [])
      )
    },
    []
  )
  useSessionRestoredBannerDismiss(
    sessionRestoredBannerPaneIds.size > 0,
    containerRef,
    dismissSessionRestoredBanner
  )

  const openDiskSpaceAnalyzer = useCallback(() => {
    setSessionStateSaveFailureOpen(false)
    openSpacePage()
    void refreshWorkspaceSpace().catch((err: unknown) => {
      console.warn('Failed to refresh Space Analyzer after terminal session save failure:', err)
    })
  }, [openSpacePage, refreshWorkspaceSpace])

  const quickCommandRepoId =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? null : getRepoIdFromWorktreeId(worktreeId)
  const quickCommandRepo = useRepoById(quickCommandRepoId)
  const quickCommandRepoLabel = quickCommandRepo
    ? quickCommandRepo.displayName || quickCommandRepo.path
    : quickCommandRepoId
      ? 'This Repo'
      : null
  const validQuickCommands = (settings?.terminalQuickCommands ?? []).filter((command) =>
    isTerminalQuickCommandComplete(command)
  )
  const repoQuickCommands = validQuickCommands.filter((command) => {
    const scope = getTerminalQuickCommandScope(command)
    return scope.type === 'repo' && terminalQuickCommandMatchesRepo(command, quickCommandRepoId)
  })
  const globalQuickCommands = validQuickCommands.filter(
    (command) => getTerminalQuickCommandScope(command).type === 'global'
  )
  const quickCommandGroupId =
    useAppStore(
      (s) =>
        getCachedTerminalGroupIdForWorktree(s.unifiedTabsByWorktree, worktreeId, tabId) ??
        s.activeGroupIdByWorktree[worktreeId] ??
        null
    ) ?? null

  const openQuickCommandEditor = useCallback((scope: TerminalQuickCommandScope): void => {
    setQuickCommandDraft(createTerminalQuickCommandDraft(scope))
    setQuickCommandEditorOpen(true)
  }, [])

  const saveQuickCommand = useCallback(
    (command: TerminalQuickCommand): void => {
      const currentCommands = useAppStore.getState().settings?.terminalQuickCommands ?? []
      void updateSettings({ terminalQuickCommands: [...currentCommands, command] })
    },
    [updateSettings]
  )

  useEffect(() => {
    if (setupSplit) {
      consumeTabSetupSplit(tabId)
    }
  }, [setupSplit, tabId, consumeTabSetupSplit])

  // Clear the queued issue-command split once this tab has captured it for initial mount.
  useEffect(() => {
    if (issueCommandSplit) {
      consumeTabIssueCommandSplit(tabId)
    }
  }, [issueCommandSplit, tabId, consumeTabIssueCommandSplit])

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const openLinksInAppPreferencePromiseRef = useRef<Promise<boolean> | null>(null)

  const requestOpenLinksInAppPreference = useCallback(
    (url: string): Promise<boolean> | null => {
      if (settingsRef.current?.openLinksInAppPreferencePrompted === true) {
        return null
      }
      if (!settingsRef.current) {
        return null
      }
      if (openLinksInAppPreferencePromiseRef.current) {
        return openLinksInAppPreferencePromiseRef.current
      }
      const preferencePromise = (async () => {
        const openInOrca = await requestLinkRoutingPreference({
          openLinksInAppDefault: settingsRef.current?.openLinksInApp === true,
          url
        })
        await updateSettings({
          openLinksInApp: openInOrca,
          openLinksInAppPreferencePrompted: true
        })
        return openInOrca
      })()
      openLinksInAppPreferencePromiseRef.current = preferencePromise
      void preferencePromise.finally(() => {
        openLinksInAppPreferencePromiseRef.current = null
      })
      return preferencePromise
    },
    [requestLinkRoutingPreference, updateSettings]
  )
  // Why: the persisted setting can be 'auto' (default) or one of the four
  // explicit modes. useEffectiveMacOptionAsAlt resolves 'auto' into
  // 'true' | 'false' based on the probe's current layout category (US → 'true',
  // anything else → 'false'), and re-renders when the OS layout changes.
  // Downstream keyboard handlers read the ref, so the ref also tracks the
  // effective value, not the raw setting.
  const effectiveMacOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  const macOptionAsAltRef = useRef<MacOptionAsAlt>(effectiveMacOptionAsAlt)
  macOptionAsAltRef.current = effectiveMacOptionAsAlt
  const onPtyExitRef = useRef(onPtyExit)
  onPtyExitRef.current = onPtyExit

  const systemPrefersDark = useSystemPrefersDark()
  const dispatchNotification = useNotificationDispatch(worktreeId)
  const setCacheTimerStartedAt = useAppStore((store) => store.setCacheTimerStartedAt)

  // Memoized with useCallback so downstream hooks (useTerminalKeyboardShortcuts,
  // useTerminalPaneLifecycle, createExpandCollapseActions) don't tear down and
  // re-register event listeners on every render. All data it reads comes from
  // refs (managerRef, containerRef, expandedPaneIdRef, paneTitlesRef) or
  // stable values (tabId, setTabLayout), so the dependency array is minimal.
  const persistLayoutSnapshot = useCallback((): void => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      return
    }
    const activePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const leafIdByPaneId = manager.getLeafIdMap()
    const layout = serializeTerminalLayout(
      container,
      activePaneId,
      expandedPaneIdRef.current,
      leafIdByPaneId
    )
    const existing = useAppStore.getState().terminalLayoutsByTabId[tabId]
    const currentPanes = manager.getPanes()
    const currentLeafIds = new Set(currentPanes.map((p) => p.leafId))
    const clearedScrollbackLeafIds = clearedScrollbackLeafIdsRef.current
    const scrollbackPreserveLeafIds = new Set(
      [...currentLeafIds].filter((leafId) => !clearedScrollbackLeafIds.has(leafId))
    )
    // Preserve existing buffersByLeafId so layout-only persists (resize, split,
    // reorder) don't clobber previously captured scrollback. Drop entries for
    // leaves that no longer exist.
    const mergedBuffers = mergeCapturedLeafState({
      prior: existing?.buffersByLeafId,
      fresh: {},
      currentLeafIds: scrollbackPreserveLeafIds
    })
    if (Object.keys(mergedBuffers).length > 0) {
      layout.buffersByLeafId = mergedBuffers
    }
    const mergedScrollbackRefs = mergeCapturedLeafState({
      prior: existing?.scrollbackRefsByLeafId,
      fresh: {},
      currentLeafIds: scrollbackPreserveLeafIds
    })
    if (Object.keys(mergedScrollbackRefs).length > 0) {
      layout.scrollbackRefsByLeafId = mergedScrollbackRefs
    }
    // Why: between pane creation and the deferred rAF where PTYs actually
    // attach, all transports have getPtyId() === null. The merge below
    // preserves the *prior* snapshot's leaf→PTY mappings while still letting
    // any live transports overwrite them. Without preservation, a rapid
    // successive remount (tab moved again before the first rAF) would lose
    // the mappings and force fresh PTY spawns.
    const livePtyEntries = currentPanes
      .map((p) => [p.leafId, paneTransportsRef.current.get(p.id)?.getPtyId() ?? null] as const)
      .filter(
        (entry): entry is readonly [(typeof currentPanes)[number]['leafId'], string] =>
          entry[1] !== null
      )
    const mergedPtyIds = mergeCapturedLeafState({
      prior: existing?.ptyIdsByLeafId,
      fresh: Object.fromEntries(livePtyEntries),
      currentLeafIds
    })
    if (Object.keys(mergedPtyIds).length > 0) {
      layout.ptyIdsByLeafId = mergedPtyIds
    }
    layout.activeLeafId = resolveTerminalLayoutActiveLeafId({
      root: layout.root,
      activeLeafId: layout.activeLeafId,
      ptyIdsByLeafId: mergedPtyIds
    })
    // Preserve pane titles — uses the live React state (via ref) rather than
    // the stale Zustand value because React state reflects in-flight title
    // edits that haven't been persisted yet.
    const titlesByLeafId: Record<string, string> = {}
    const removedTitleLeafIds = removedTitleLeafIdsRef.current
    for (const pane of currentPanes) {
      const existingTitle = existing?.titlesByLeafId?.[pane.leafId]
      if (existingTitle && !removedTitleLeafIds.has(pane.leafId)) {
        titlesByLeafId[pane.leafId] = existingTitle
      }
    }
    // Why: active agents can trigger layout persists while pane-title React
    // state is catching up. Preserve existing leaf titles unless this pane
    // explicitly removed them, then overlay the live local pane-title state.
    const titles = paneTitlesRef.current
    for (const pane of currentPanes) {
      const title = titles[pane.id]
      if (title) {
        titlesByLeafId[pane.leafId] = title
        removedTitleLeafIds.delete(pane.leafId)
      }
    }
    if (Object.keys(titlesByLeafId).length > 0) {
      layout.titlesByLeafId = titlesByLeafId
    }
    setTabLayout(tabId, layout)
    // Why: pane geometry is host-authoritative for remote-server tabs, so push
    // ratios/expand/titles to the host or they revert on the next snapshot.
    // Gate on a remote pty to avoid an RPC for purely-local tabs.
    const hasRemotePane = Object.values(mergedPtyIds).some(
      (ptyId) => typeof ptyId === 'string' && isRemoteRuntimePtyId(ptyId)
    )
    if (hasRemotePane) {
      void updateWebRuntimePaneLayout({
        worktreeId,
        tabId,
        root: layout.root,
        expandedLeafId: layout.expandedLeafId,
        ...(layout.titlesByLeafId ? { titlesByLeafId: layout.titlesByLeafId } : {})
      })
    }
    for (const leafId of currentLeafIds) {
      clearedScrollbackLeafIds.delete(leafId)
    }
  }, [tabId, setTabLayout, worktreeId])

  const clearPaneScrollback = useCallback(
    (pane: ManagedPane): void => {
      clearedScrollbackLeafIdsRef.current.add(pane.leafId)
      pane.terminal.clear()
      // Why: also clear the host buffer for remote-server panes, or the next
      // host snapshot replays the scrollback we just cleared locally.
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      const clearedRemoteHostBuffer = clearWebRuntimeTerminalBuffer(ptyId)
      if (!clearedRemoteHostBuffer && ptyId) {
        // Why: local/daemon/SSH PTYs keep their own screen state (ConPTY on
        // Windows), and a stale host cursor row makes the next prompt repaint
        // land below a blank gap after a frontend-only clear.
        window.api.pty.clearBuffer(ptyId)
      }
      persistLayoutSnapshot()
    },
    [paneTransportsRef, persistLayoutSnapshot]
  )

  /**
   * Removes a custom pane title from React state, the fresh persistence ref,
   * and the leaf-id tombstone set so the next layout snapshot stays cleared.
   */
  const removePaneTitle = useCallback(
    (paneId: number) => {
      setPaneTitles((prev) => {
        if (!(paneId in prev)) {
          return prev
        }
        const next = { ...prev }
        delete next[paneId]
        return next
      })
      // Eagerly remove from the ref so persistLayoutSnapshot sees the change.
      if (paneId in paneTitlesRef.current) {
        const next = { ...paneTitlesRef.current }
        delete next[paneId]
        paneTitlesRef.current = next
      }
      const leafId = managerRef.current?.getPanes().find((pane) => pane.id === paneId)?.leafId
      if (leafId) {
        removedTitleLeafIdsRef.current.add(leafId)
      }
      persistLayoutSnapshot()
    },
    [persistLayoutSnapshot]
  )

  /**
   * Ignores clear-title shortcuts for panes already using their automatic
   * title, keeping the command idempotent and avoiding unnecessary snapshots.
   */
  const handleClearPaneTitleShortcut = useCallback(
    (paneId: number) => {
      if (!paneTitlesRef.current[paneId]) {
        return
      }
      removePaneTitle(paneId)
    },
    [removePaneTitle]
  )

  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const sanitized = sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab)
    if (sanitized !== savedLayout) {
      setTabLayout(tabId, sanitized)
    }
  }, [savedLayout, setTabLayout, tabId, terminalTab])

  useEffect(() => {
    if (!terminalTab) {
      return
    }
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const panes = manager.getPanes()
    if (panes.length !== 1) {
      return
    }
    const paneId = panes[0].id
    const currentTitle = paneTitlesRef.current[paneId]
    if (!currentTitle || !isSyntheticSinglePaneTitle(currentTitle, terminalTab)) {
      return
    }
    const nextTitles = { ...paneTitlesRef.current }
    delete nextTitles[paneId]
    paneTitlesRef.current = nextTitles
    setPaneTitles((prev) => {
      if (!prev[paneId] || !isSyntheticSinglePaneTitle(prev[paneId], terminalTab)) {
        return prev
      }
      const next = { ...prev }
      delete next[paneId]
      return next
    })
    persistLayoutSnapshot()
  }, [paneCount, paneTitles, persistLayoutSnapshot, terminalTab])

  const writePanePtyLayoutBinding = useCallback(
    (paneId: number, ptyId: string | null, repairActiveLeafOnClear: boolean): void => {
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT
      const { ptyIdsByLeafId: _existingPtyIdsByLeafId, ...layoutWithoutPtyBindings } =
        existingLayout
      const existingBindings = existingLayout.ptyIdsByLeafId ?? {}
      const leafId = managerRef.current?.getLeafId(paneId)
      if (!leafId) {
        return
      }

      if (ptyId) {
        setTabLayout(tabId, {
          ...layoutWithoutPtyBindings,
          // Why: PTY ownership changes happen after the synchronous layout
          // snapshot on mount. Persist the live pane→PTY binding here so
          // remounts attach each pane to its current shell instead of a stale
          // or missing PTY id from an earlier snapshot.
          ptyIdsByLeafId: {
            ...existingBindings,
            [leafId]: ptyId
          }
        })
        return
      }

      const nextBindings = { ...existingBindings }
      delete nextBindings[leafId]
      const nextLayout = {
        ...layoutWithoutPtyBindings,
        ...(Object.keys(nextBindings).length > 0 ? { ptyIdsByLeafId: nextBindings } : {})
      }
      if (
        repairActiveLeafOnClear &&
        existingLayout.activeLeafId === leafId &&
        Object.keys(nextBindings).length > 0
      ) {
        // Why: an active pane that lost its PTY would keep swallowing input if
        // sibling bound panes are available; replacement/restart bookkeeping
        // opts out so focus stays with the pane about to receive a fresh PTY.
        nextLayout.activeLeafId = resolveTerminalLayoutActiveLeafId({
          root: nextLayout.root,
          activeLeafId: nextLayout.activeLeafId,
          ptyIdsByLeafId: nextBindings
        })
      }
      setTabLayout(tabId, nextLayout)
    },
    [setTabLayout, tabId]
  )

  const syncPanePtyLayoutBinding = useCallback(
    (paneId: number, ptyId: string | null): void => {
      writePanePtyLayoutBinding(paneId, ptyId, false)
    },
    [writePanePtyLayoutBinding]
  )

  const clearExitedPanePtyLayoutBinding = useCallback(
    (paneId: number, exitedPtyId: string): void => {
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT
      const { ptyIdsByLeafId: _existingPtyIdsByLeafId, ...layoutWithoutPtyBindings } =
        existingLayout
      const existingBindings = existingLayout.ptyIdsByLeafId ?? {}
      const leafId = managerRef.current?.getLeafId(paneId)
      if (!leafId || existingBindings[leafId] !== exitedPtyId) {
        return
      }

      const nextBindings = { ...existingBindings }
      delete nextBindings[leafId]
      // Why: a focused pane that lost its PTY can swallow input while a live
      // sibling still exists, so unexpected exits repair focus to a bound leaf.
      setTabLayout(tabId, {
        ...layoutWithoutPtyBindings,
        activeLeafId: resolveTerminalLayoutActiveLeafId({
          root: existingLayout.root,
          activeLeafId: existingLayout.activeLeafId,
          ptyIdsByLeafId: nextBindings
        }),
        ...(Object.keys(nextBindings).length > 0 ? { ptyIdsByLeafId: nextBindings } : {})
      })
    },
    [setTabLayout, tabId]
  )

  const {
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    syncExpandedLayout,
    toggleExpandPane
  } = createExpandCollapseActions({
    expandedPaneIdRef,
    expandedStyleSnapshotRef,
    containerRef,
    managerRef,
    pendingPaneSizeRefreshFrameIdsRef,
    setExpandedPaneId,
    setTabPaneExpanded,
    tabId,
    persistLayoutSnapshot
  })

  const executeClosePane = useCallback(
    (paneId: number) => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      if (manager.getPanes().length <= 1) {
        onCloseTab()
      } else {
        // Why: clear the cache timer for this specific pane before closing it,
        // so the sidebar doesn't show a stale countdown for a pane that no
        // longer exists. The closeTab path handles bulk cleanup, but closing
        // a single split pane doesn't go through closeTab.
        const ptyId = paneTransportsRef.current.get(paneId)?.getPtyId() ?? null
        closeWebRuntimeTerminal(ptyId)
        clearSessionRestoredBannerForPane(paneId)
        const leafId = manager.getLeafId(paneId)
        if (leafId) {
          useAppStore.getState().setCacheTimerStartedAt(makePaneKey(tabId, leafId), null)
          useAppStore.getState().dropAgentStatus(makePaneKey(tabId, leafId))
        }
        syncPanePtyLayoutBinding(paneId, null)
        manager.closePane(paneId)
      }
    },
    [clearSessionRestoredBannerForPane, onCloseTab, syncPanePtyLayoutBinding, tabId]
  )

  // Cmd+W handler — shows a confirmation dialog when the pane's shell has
  // a running child process (e.g. npm run dev), so the user doesn't
  // accidentally kill it. An idle shell prompt closes immediately. Ctrl+D
  // (explicit EOF) bypasses this by design.
  const getCloseDialogCopyKind = useCallback(
    (paneId: number): CloseTerminalDialogCopyKind => {
      const leafId = managerRef.current?.getLeafId(paneId)
      if (!leafId) {
        return 'command'
      }
      const agentType =
        useAppStore.getState().agentStatusByPaneKey[makePaneKey(tabId, leafId)]?.agentType
      return agentType && agentType !== 'unknown' ? 'agent' : 'command'
    },
    [tabId]
  )

  const handleRequestClosePane = useCallback(
    (paneId: number) => {
      // Why: when closing the last pane of a pinned tab, the pin confirmation
      // takes precedence over the running-process prompt — let executeClosePane
      // fall through to closeTerminalTab, which raises the single pin dialog
      // (confirming it kills the process). Non-pinned tabs keep the process prompt.
      const isLastPane = (managerRef.current?.getPanes().length ?? 0) <= 1
      if (isLastPane) {
        const state = useAppStore.getState()
        const confirmPinned = state.settings?.confirmClosePinnedTab ?? true
        if (confirmPinned && isUnifiedTabPinned(state, worktreeId, tabId)) {
          executeClosePane(paneId)
          return
        }
      }
      const transport = paneTransportsRef.current.get(paneId)
      const ptyId = transport?.getPtyId()
      if (!ptyId) {
        executeClosePane(paneId)
        return
      }
      const settings = useAppStore.getState().settings
      void inspectRuntimeTerminalProcess(settings, ptyId)
        .then((process) => {
          if (!process.hasChildProcesses || settings?.skipCloseTerminalWithRunningProcessConfirm) {
            executeClosePane(paneId)
          } else {
            setPendingCloseConfirmation({ paneId, copyKind: getCloseDialogCopyKind(paneId) })
          }
        })
        // Why: if the child-process probe rejects (IPC wedged, handler
        // missing on legacy providers), fall back to closing the pane — Cmd+W
        // silently doing nothing is worse than closing a pane that might have
        // had a child process. Matches the semantics of the !ptyId branch above.
        .catch(() => executeClosePane(paneId))
    },
    [executeClosePane, tabId, worktreeId, getCloseDialogCopyKind]
  )

  const handleSearchSelectedText = useCallback((selectedText: string): void => {
    const state = useAppStore.getState()
    state.showRightSidebarSearch({ query: selectedText })
  }, [])

  const handleConfirmClose = useCallback(
    (dontAskAgain: boolean) => {
      if (pendingCloseConfirmation === null) {
        return
      }
      const paneId = pendingCloseConfirmation.paneId
      setPendingCloseConfirmation(null)
      if (dontAskAgain) {
        void updateSettings({ skipCloseTerminalWithRunningProcessConfirm: true })
      }
      executeClosePane(paneId)
    },
    [executeClosePane, pendingCloseConfirmation, updateSettings]
  )

  const handleCancelClose = useCallback(() => {
    setPendingCloseConfirmation(null)
  }, [])

  const resolveExternalPaneDropTarget = useCallback(
    ({
      sourcePaneId,
      clientX,
      clientY
    }: {
      sourcePaneId: number
      clientX: number
      clientY: number
    }): PaneExternalDropTarget | null => {
      const manager = managerRef.current
      const panes = manager?.getPanes() ?? []
      if (panes.length <= 1 || !panes.some((pane) => pane.id === sourcePaneId)) {
        return null
      }
      return resolveTerminalTabStripDropTarget({
        clientX,
        clientY,
        groupsByWorktree: useAppStore.getState().groupsByWorktree,
        worktreeId
      })
    },
    [worktreeId]
  )

  const handleExternalPaneDrop = useCallback(
    (sourcePaneId: number, target: PaneExternalDropTarget): boolean => {
      if (!isTerminalTabStripDropTarget(target)) {
        return false
      }
      const fallbackPtyId = paneTransportsRef.current.get(sourcePaneId)?.getPtyId() ?? null
      return (
        detachTerminalPaneToTab({
          fallbackPtyId,
          getStore: useAppStore.getState,
          manager: managerRef.current,
          persistLayoutSnapshot,
          sourcePaneId,
          sourceTabId: tabId,
          targetGroupId: target.groupId,
          targetIndex: target.insertionIndex,
          worktreeId
        }) !== null
      )
    },
    [persistLayoutSnapshot, tabId, worktreeId]
  )

  useTerminalPaneLifecycle({
    tabId,
    worktreeId,
    cwd,
    startup,
    setupSplit,
    issueCommandSplit,
    isActive,
    isVisible: isRendererVisible,
    systemPrefersDark,
    settings,
    settingsRef,
    requestOpenLinksInAppPreference,
    effectiveMacOptionAsAlt,
    effectiveMacOptionAsAltRef: macOptionAsAltRef,
    initialLayoutRef,
    managerRef,
    containerRef,
    expandedStyleSnapshotRef,
    paneFontSizesRef,
    paneTransportsRef,
    paneCwdRef,
    paneMode2031Ref,
    paneKittyKeyboardModesRef,
    paneLastThemeModeRef,
    panePtyBindingsRef,
    replayingPanesRef,
    isActiveRef,
    isVisibleRef,
    onPtyExitRef,
    onPtyErrorRef,
    clearTabPtyId,
    consumeSuppressedPtyExit: useAppStore((store) => store.consumeSuppressedPtyExit),
    updateTabTitle,
    setRuntimePaneTitle,
    clearRuntimePaneTitle,
    updateTabPtyId,
    markWorktreeUnread,
    markTerminalTabUnread,
    markTerminalPaneUnread,
    clearWorktreeUnread,
    clearTerminalTabUnread,
    clearTerminalPaneUnread,
    onShowSessionRestoredBanner: showRestoredSessionBanner,
    dispatchNotification,
    setCacheTimerStartedAt,
    syncPanePtyLayoutBinding,
    clearExitedPanePtyLayoutBinding,
    setTabPaneExpanded,
    setTabCanExpandPane,
    setExpandedPane,
    syncExpandedLayout,
    persistLayoutSnapshot,
    setPaneTitles,
    paneTitlesRef,
    setRenamingPaneId,
    setPaneCount,
    setPaneLayoutRevision,
    resolveExternalPaneDropTarget,
    onExternalPaneDrop: handleExternalPaneDrop
  })

  useEffect(() => {
    const manager = managerRef.current
    if (!manager || !restoredLayout.root) {
      return
    }
    // Host-owned split layouts (web clients, or a desktop client viewing a
    // remote server worktree) arrive via the host snapshot, so the reconciler
    // must materialize their panes; local desktop tabs split directly.
    if (
      !isHostAuthoritativeLayout({
        isWebClient: !!(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__,
        ptyIdsByLeafId: restoredLayout.ptyIdsByLeafId
      })
    ) {
      return
    }
    const insertions = planTerminalLiveLayoutInsertions(
      restoredLayout.root,
      manager.getPanes().map((pane) => pane.leafId)
    )
    if (insertions.length === 0) {
      return
    }

    let appliedInsertion = false
    for (const insertion of insertions) {
      const ptyId = restoredLayout.ptyIdsByLeafId?.[insertion.newLeafId]
      const sourcePaneId = manager.getNumericIdForLeaf(insertion.sourceLeafId)
      if (!ptyId || sourcePaneId === null || manager.getNumericIdForLeaf(insertion.newLeafId)) {
        continue
      }
      // Why: paired web terminals receive host split-pane snapshots after the
      // pane manager is already mounted. Adopt the host leaf + PTY instead of
      // spawning a local-only web pane.
      // Before-placement swaps [source, new] after splitPane, so invert the
      // host first-child ratio before applying it to the temporary order.
      const splitRatio =
        insertion.ratio === undefined
          ? undefined
          : insertion.placement === 'before'
            ? 1 - insertion.ratio
            : insertion.ratio
      const createdPane = manager.splitPaneAroundLeafIds(
        insertion.sourceLeafIds,
        sourcePaneId,
        insertion.direction,
        {
          ...(splitRatio !== undefined && { ratio: splitRatio }),
          leafId: insertion.newLeafId,
          ptyId,
          placement: insertion.placement
        }
      )
      if (!createdPane) {
        continue
      }
      appliedInsertion = true
    }

    if (appliedInsertion) {
      persistLayoutSnapshot()
    }

    const activePaneId = restoredLayout.activeLeafId
      ? manager.getNumericIdForLeaf(restoredLayout.activeLeafId)
      : null
    const fallbackActivePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const nextActivePaneId = activePaneId ?? fallbackActivePaneId
    if (nextActivePaneId !== null) {
      manager.setActivePane(nextActivePaneId, { focus: isActive })
    }
  }, [isActive, paneCount, persistLayoutSnapshot, restoredLayout])

  // Why (Activity-only pane isolation): when this TerminalPane is being
  // portaled into the Activity page for a specific agent pane, hide the
  // other split siblings so the user only sees that agent's pane. Uses
  // applyExpandedLayoutTo with a separate snapshot ref so the override is
  // independent of the user-facing expanded-pane state and the persisted
  // layout snapshot — closing Activity restores the original split layout.
  // useLayoutEffect: layout style writes must land before paint to avoid
  // a flash of all panes. paneCount is in deps so the effect re-applies
  // after splits/closes change the manager's pane list.
  useLayoutEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    // Why: refit on rAF so xterm measures the post-layout DOM, not the
    // pre-toggle one. Mirrors expand-collapse.refreshPaneSizes. Both the
    // apply and restore paths must refit — restoring without a fit leaves
    // xterm sized for the isolated single-pane geometry, so the workspace
    // view (or staging slot) renders at the wrong cols/rows until some
    // unrelated event triggers another fit.
    const scheduleRefit = (): number =>
      requestAnimationFrame(() => {
        const manager = managerRef.current
        if (!manager) {
          return
        }
        for (const pane of manager.getPanes()) {
          safeFit(pane)
        }
      })
    if (isolatedPaneKey === null) {
      restoreExpandedLayoutFrom(snapshots)
      const frame = scheduleRefit()
      return () => {
        cancelAnimationFrame(frame)
      }
    }
    const manager = managerRef.current
    const resolution = resolvePaneKeyForManager(tabId, isolatedPaneKey, manager)
    const resolvedPaneId = resolution.status === 'resolved' ? resolution.numericPaneId : null
    const applied =
      resolvedPaneId !== null &&
      ((manager?.getPanes().length ?? 0) <= 1 ||
        applyExpandedLayoutTo(resolvedPaneId, {
          managerRef,
          containerRef,
          expandedStyleSnapshotRef: activityIsolationSnapshotRef
        }))
    if (!applied) {
      restoreExpandedLayoutFrom(snapshots)
      const root = containerRef.current?.firstElementChild
      if (root instanceof HTMLElement) {
        // Why: Activity requested an exact pane. If it cannot be resolved, fail
        // closed instead of showing the whole split terminal as a fallback.
        snapshots.set(root, { display: root.style.display, flex: root.style.flex })
        root.style.display = 'none'
      }
      const frame = scheduleRefit()
      return () => {
        cancelAnimationFrame(frame)
      }
    }
    const frame = scheduleRefit()
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [isolatedPaneKey, paneCount, tabId])

  // Why: belt-and-suspenders unmount cleanup. If the component unmounts
  // while isolation is active (e.g. tab closed mid-Activity-view), restore
  // sibling display/flex so the captured DOM doesn't leak inline styles.
  useEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    return () => {
      restoreExpandedLayoutFrom(snapshots)
      cancelPendingPaneSizeRefreshFrames({ pendingPaneSizeRefreshFrameIdsRef })
    }
  }, [])

  const handleRestartCodexPane = useCallback(
    (paneId: number) => {
      const manager = managerRef.current
      const pane = manager?.getPanes().find((candidate) => candidate.id === paneId)
      if (!manager || !pane) {
        return
      }

      const transport = paneTransportsRef.current.get(paneId)
      const panePtyBinding = panePtyBindingsRef.current.get(paneId)
      const existingPtyId = transport?.getPtyId()

      if (existingPtyId) {
        suppressPtyExit(existingPtyId)
        clearCodexRestartNotice(existingPtyId)
        // Why: pane-scoped Codex restarts should preserve the split layout and
        // replace only the stale session in place. Clearing the PTY binding and
        // consuming the upcoming suppressed exit keeps the pane mounted while a
        // fresh PTY reconnects under the newly selected Codex account.
        clearTabPtyId(tabId, existingPtyId)
      }

      panePtyBinding?.dispose()
      panePtyBindingsRef.current.delete(paneId)
      syncPanePtyLayoutBinding(paneId, null)
      transport?.destroy?.()
      paneTransportsRef.current.delete(paneId)
      setCacheTimerStartedAt(makePaneKey(tabId, pane.leafId), null)
      setTerminalError(null)

      const newPaneBinding = connectPanePty(pane, manager, {
        tabId,
        worktreeId,
        cwd,
        startup: { command: 'codex' },
        paneTransportsRef,
        paneMode2031Ref,
        paneKittyKeyboardModesRef,
        paneLastThemeModeRef,
        replayingPanesRef,
        isActiveRef,
        isVisibleRef,
        onPtyExitRef,
        onPtyErrorRef,
        clearTabPtyId,
        consumeSuppressedPtyExit: useAppStore.getState().consumeSuppressedPtyExit,
        updateTabTitle,
        setRuntimePaneTitle,
        clearRuntimePaneTitle,
        updateTabPtyId,
        markWorktreeUnread,
        markTerminalTabUnread,
        markTerminalPaneUnread,
        clearWorktreeUnread,
        clearTerminalTabUnread,
        clearTerminalPaneUnread,
        onShowSessionRestoredBanner: showRestoredSessionBanner,
        dispatchNotification,
        setCacheTimerStartedAt,
        syncPanePtyLayoutBinding,
        clearExitedPanePtyLayoutBinding
      })
      panePtyBindingsRef.current.set(paneId, newPaneBinding)
      manager.setActivePane(paneId, { focus: true })
    },
    [
      clearCodexRestartNotice,
      clearExitedPanePtyLayoutBinding,
      clearRuntimePaneTitle,
      clearTabPtyId,
      cwd,
      dispatchNotification,
      markWorktreeUnread,
      markTerminalTabUnread,
      markTerminalPaneUnread,
      clearWorktreeUnread,
      clearTerminalTabUnread,
      clearTerminalPaneUnread,
      showRestoredSessionBanner,
      onPtyExitRef,
      setCacheTimerStartedAt,
      setRuntimePaneTitle,
      suppressPtyExit,
      syncPanePtyLayoutBinding,
      tabId,
      updateTabPtyId,
      updateTabTitle,
      worktreeId
    ]
  )

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }

    for (const pane of manager.getPanes()) {
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
      if (!ptyId || !pendingCodexPaneRestartIds[ptyId]) {
        continue
      }
      // Why: the status-bar switcher can request a global restart for stale
      // Codex sessions, but the actual execution must stay pane scoped so a
      // split tab does not lose unrelated non-Codex panes.
      if (consumePendingCodexPaneRestart(ptyId)) {
        handleRestartCodexPane(pane.id)
      }
    }
  }, [consumePendingCodexPaneRestart, handleRestartCodexPane, pendingCodexPaneRestartIds])

  useTerminalFontZoom({ isActive, containerRef, managerRef, paneFontSizesRef, settingsRef })

  useTerminalKeyboardShortcuts({
    tabId,
    worktreeId,
    isActive,
    keyboardScopeRef: containerRef,
    managerRef,
    paneTransportsRef,
    panePtyBindingsRef,
    paneCwdRef,
    fallbackCwd: cwd ?? '',
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    onSearchSelectedText: handleSearchSelectedText,
    onRequestClosePane: handleRequestClosePane,
    onClearPaneScrollback: clearPaneScrollback,
    onSetTitle: handleStartRename,
    onClearPaneTitle: handleClearPaneTitleShortcut,
    searchOpenRef,
    searchStateRef,
    macOptionAsAltRef,
    paneKittyKeyboardModesRef,
    keybindings,
    terminalShortcutPolicy: settings?.terminalShortcutPolicy ?? 'orca-first'
  })

  useTerminalPaneGlobalEffects({
    tabId,
    // Why: use the pane's own `worktreeId` prop (not global activeWorktreeId)
    // so the terminal-drop resolver routes to the worktree that actually owns
    // this PTY. Reading from global state would race during worktree switches
    // — the drop listener is already gated by `isActive`, and the pane's own
    // id is the authoritative identity of the terminal being written to.
    worktreeId,
    cwd,
    isActive,
    isVisible,
    isWorktreeActive,
    // Why: hidden startup probes are opacity-hidden but measurable; ordinary
    // hidden tabs are display:none and refit on visibility resume instead.
    isSyncFitEnabled: isRendererVisible || shouldMeasureHiddenStartup,
    paneCount,
    managerRef,
    containerRef,
    paneTransportsRef,
    isActiveRef,
    isVisibleRef,
    toggleExpandPane
  })

  useEffect(() => {
    if (
      !(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ ||
      !isVisible ||
      !isActive
    ) {
      return
    }

    const cleanupCallbacks: (() => void)[] = []
    const fitAndForward = (): void => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      for (const pane of manager.getPanes()) {
        safeFit(pane)
        const transport = paneTransportsRef.current.get(pane.id)
        if (!transport?.isConnected()) {
          continue
        }
        const ptyId = transport.getPtyId()
        if (!ptyId) {
          continue
        }
        // Why: match pty-connection resize guards so web refit retries do not
        // forward SIGWINCH while mobile-lock or phone-fit overrides are active.
        if (getFitOverrideForPty(ptyId) || isPtyLocked(ptyId)) {
          continue
        }
        // Why: skip forwarding a stale near-zero fit to the host PTY while the
        // overlay is still settling after a worktree switch.
        if (pane.terminal.cols < 8 || pane.terminal.rows < 4) {
          continue
        }
        transport.resize(pane.terminal.cols, pane.terminal.rows)
      }
    }
    const scheduleFrame = (): void => {
      const frameId = requestAnimationFrame(fitAndForward)
      cleanupCallbacks.push(() => cancelAnimationFrame(frameId))
    }
    const scheduleTimer = (delayMs: number): void => {
      const timerId = window.setTimeout(fitAndForward, delayMs)
      cleanupCallbacks.push(() => window.clearTimeout(timerId))
    }

    // Why: web-restored terminals can fit before the remote PTY transport is
    // ready, then become xterm no-ops. Forward the settled cols explicitly.
    scheduleFrame()
    scheduleTimer(50)
    scheduleTimer(150)
    scheduleTimer(400)
    scheduleTimer(900)

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup()
      }
    }
  }, [isActive, isVisible])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    let ownsRegularTerminalFocus = false
    let releasedHelperOnWindowBlur: HTMLElement | null = null
    // Why: the IME refresh's synchronous blur emits a focusout that would flip
    // terminalInputFocused false mid-handoff; latch it so the main process keeps
    // routing Terminal-first shortcuts until the refocus lands.
    let refreshingImeInputContext = false
    const syncFocused = (focused: boolean): void => {
      ownsRegularTerminalFocus = focused
      if (focused) {
        releasedHelperOnWindowBlur = null
      }
      setRegularTerminalInputFocusAttribute(focused)
      window.api.ui.setTerminalInputFocused?.(focused)
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (!isXtermHelperTextarea(event.target)) {
        return
      }
      syncFocused(true)
      // Why: helper→helper pane handoffs skip window blur and can leave a stale
      // macOS NSTextInputContext; the refresh's refocus arrives with a
      // non-helper relatedTarget, so this cannot recurse.
      if (isXtermHelperTextarea(event.relatedTarget) && event.relatedTarget !== event.target) {
        refreshingImeInputContext = true
        try {
          refreshTerminalImeInputContext(event.target, {})
        } finally {
          refreshingImeInputContext = false
        }
      }
    }
    const onFocusOut = (event: FocusEvent): void => {
      if (!isXtermHelperTextarea(event.target)) {
        return
      }
      if (isXtermHelperTextarea(event.relatedTarget)) {
        return
      }
      if (refreshingImeInputContext) {
        return
      }
      syncFocused(false)
    }
    const onPointerDown = (event: PointerEvent): void => {
      releaseTerminalFocusForOutsidePointerDown({
        container,
        activeElement: document.activeElement,
        pointerTarget: event.target,
        syncFocused
      })
    }
    const onWindowBlur = (): void => {
      // Why: webview/browser handoff leaves the helper textarea as DOM focus,
      // so clear only the main-process mirror and let guest focus proceed.
      releasedHelperOnWindowBlur = releaseTerminalFocusForWindowBlur({
        container,
        activeElement: document.activeElement,
        syncFocused
      })
    }
    const onWindowFocus = (): void => {
      // Why: app reactivation can preserve DOM focus on xterm after blur
      // cleared the process-wide shortcut mirror, or move focus to body/null.
      if (
        resyncTerminalFocusForWindowFocus({
          container,
          activeElement: document.activeElement,
          syncFocused,
          releasedHelper: releasedHelperOnWindowBlur
        })
      ) {
        releasedHelperOnWindowBlur = null
      }
    }

    if (
      isXtermHelperTextarea(document.activeElement) &&
      container.contains(document.activeElement)
    ) {
      syncFocused(true)
    }
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    return () => {
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      // Why: the helper textarea may be removed before cleanup observes
      // document.activeElement, so clear by this pane's mirrored ownership.
      if (ownsRegularTerminalFocus) {
        syncFocused(false)
      }
    }
  }, [])

  // Intercept paste at the keydown level (configurable terminal paste chords)
  // AND as a fallback
  // on the paste event. We must handle keydown because Chromium does not fire
  // a paste event when the clipboard contains only image data (no text
  // representation) and the target is a textarea — which is exactly how
  // xterm.js receives focus. Without the keydown handler, image-only pastes
  // are silently discarded and tools like Claude Code never receive the image.
  //
  // The paste event handler is kept as a fallback for non-keyboard paste
  // triggers (Edit > Paste menu, programmatic paste, etc.) and also bypasses
  // Chromium's native clipboard pipeline that can cause concurrent clipboard
  // reads by CLI tools (e.g. Codex checking for images) to fail intermittently.
  useEffect(() => {
    if (!isActive) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }

    const isMac = navigator.userAgent.includes('Mac')
    const shortcutPlatform: NodeJS.Platform = isMac
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux'

    const isPanePasteTargetMounted = (
      pane: ManagedPane,
      transport: PtyTransport | undefined,
      ptyId: string | null
    ): boolean => {
      return isTerminalPanePasteTargetCurrent({
        manager: managerRef.current,
        paneTransports: paneTransportsRef.current,
        paneId: pane.id,
        leafId: pane.leafId,
        transport,
        ptyId
      })
    }

    const executePanePasteText = async (
      pane: ManagedPane,
      source: TerminalPasteSource,
      activeElementAtDispatch: Element | null,
      text: string,
      options?: TerminalPasteTextOptions
    ): Promise<void> => {
      const connectionId = getConnectionId(worktreeId) ?? null
      const transport = paneTransportsRef.current.get(pane.id)
      const ptyId = transport?.getPtyId() ?? null
      const keyboardOwnedPaste =
        source === 'keyboard' || source === 'paste-event' || source === 'app-menu'
      const plan = await planTerminalPasteWithYield({
        text,
        source,
        target: {
          kind: 'terminal',
          paneId: pane.id,
          leafId: pane.leafId,
          ptyId,
          runtime: resolveTerminalPasteRuntime({
            platform: shortcutPlatform,
            ptyId,
            connectionId,
            remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
            transport,
            isWindowsConpty: forceBracketedMultilineTextPaste
          })
        },
        forceBracketedPaste: options?.forceBracketedPaste,
        forceBracketedPasteForMultiline: options?.forceBracketedPasteForMultiline,
        terminalBracketedPasteMode: pane.terminal.modes.bracketedPasteMode
      })
      const execution = await executeTerminalPastePlan(plan, {
        pasteText: (pasteText, pasteOptions) =>
          pasteTerminalText(pane.terminal, pasteText, pasteOptions),
        writePty: (data) => writeTerminalPastePtyInput(transport, data),
        isTargetCurrent: () => {
          if (!isPanePasteTargetMounted(pane, transport, ptyId)) {
            return false
          }
          return isTerminalPanePasteFocusCurrent({
            requireSameFocusedElement: keyboardOwnedPaste,
            activeElementAtDispatch,
            paneContainer: pane.container
          })
        },
        canContinue: () => isPanePasteTargetMounted(pane, transport, ptyId)
      })
      if (execution.status !== 'pasted') {
        setTerminalError(formatTerminalPasteExecutionError(execution.reason))
        return
      }
      if (text) {
        recordTerminalUserInputForLeaf(tabId, pane.leafId)
      }
      if (options?.recoverImagePasteWebglAtlas) {
        scheduleImagePasteWebglAtlasRecovery()
      }
    }

    const pasteFromClipboard = (
      pane: ManagedPane,
      source: Extract<TerminalPasteSource, 'keyboard' | 'paste-event'>
    ): void => {
      const connectionId = getConnectionId(worktreeId) ?? null
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        useAppStore.getState(),
        worktreeId
      )
      const activeElementAtDispatch = document.activeElement
      void pasteTerminalClipboard({
        readClipboardText: window.api.ui.readClipboardText,
        saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
        connectionId,
        runtimeEnvironmentId,
        forceBracketedMultilineTextPaste,
        pasteText: (text, options) =>
          executePanePasteText(pane, source, activeElementAtDispatch, text, options),
        onTextPasteError: () =>
          setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.'),
        onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error))
      }).catch(() => {
        setTerminalError('Paste failed.')
      })
    }

    let suppressNextNativePaste = false
    let pasteSuppressionTimerId: number | null = null
    const shouldSuppressNativePaste = (e: KeyboardEvent): boolean => {
      const key = e.key.toLowerCase()
      return (
        (isMac && key === 'v' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) ||
        (!isMac && key === 'v' && e.ctrlKey && !e.metaKey && !e.altKey) ||
        (!isMac && e.key === 'Insert' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)
      )
    }
    const onKeyPaste = (e: KeyboardEvent): void => {
      const target = e.target
      if (
        (target instanceof Element && target.closest('[data-terminal-search-root]')) ||
        isInsideNativeChatRoot(target)
      ) {
        return
      }
      const matchesPaste = keybindingMatchesAction(
        'terminal.paste',
        e,
        shortcutPlatform,
        keybindings,
        { context: 'terminal' }
      )
      if (!matchesPaste) {
        if (shouldSuppressNativePaste(e)) {
          // Why: bare Ctrl+V is readline's quote-insert on Windows/Linux. If
          // Chromium turns it into a native paste event, suppress that follow-up
          // paste while still letting xterm receive the original keydown.
          suppressNextNativePaste = true
          if (pasteSuppressionTimerId !== null) {
            window.clearTimeout(pasteSuppressionTimerId)
          }
          pasteSuppressionTimerId = window.setTimeout(() => {
            pasteSuppressionTimerId = null
            suppressNextNativePaste = false
          }, 0)
        }
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      suppressNextNativePaste = true
      if (pasteSuppressionTimerId !== null) {
        window.clearTimeout(pasteSuppressionTimerId)
      }
      pasteSuppressionTimerId = window.setTimeout(() => {
        pasteSuppressionTimerId = null
        suppressNextNativePaste = false
      }, 0)
      pasteFromClipboard(pane, 'keyboard')
    }

    // Fallback: handle paste events triggered by non-keyboard sources
    // (Edit > Paste menu, programmatic paste, etc.).
    const onPaste = (e: ClipboardEvent): void => {
      const target = e.target
      if (
        (target instanceof Element && target.closest('[data-terminal-search-root]')) ||
        isInsideNativeChatRoot(target)
      ) {
        return
      }
      if (suppressNextNativePaste) {
        suppressNextNativePaste = false
        if (pasteSuppressionTimerId !== null) {
          window.clearTimeout(pasteSuppressionTimerId)
          pasteSuppressionTimerId = null
        }
        e.preventDefault()
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      pasteFromClipboard(pane, 'paste-event')
    }

    const onAppMenuPaste = (event: Event): void => {
      const activeElementAtDispatch = document.activeElement
      if (
        !(activeElementAtDispatch instanceof Element) ||
        !container.contains(activeElementAtDispatch) ||
        activeElementAtDispatch.closest('[data-terminal-search-root]') ||
        isInsideNativeChatRoot(activeElementAtDispatch)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      const connectionId = getConnectionId(worktreeId) ?? null
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        useAppStore.getState(),
        worktreeId
      )
      void pasteTerminalClipboard({
        readClipboardText: window.api.ui.readClipboardText,
        saveClipboardImageAsTempFile: window.api.ui.saveClipboardImageAsTempFile,
        connectionId,
        runtimeEnvironmentId,
        forceBracketedMultilineTextPaste,
        pasteText: (text, options) =>
          executePanePasteText(pane, 'app-menu', activeElementAtDispatch, text, options),
        onTextPasteError: () =>
          setTerminalError('Paste failed: clipboard text is too large for a safe terminal paste.'),
        onImagePasteError: (error) => setTerminalError(formatClipboardImagePasteError(error))
      }).catch(() => {
        setTerminalError('Paste failed.')
      })
    }

    container.addEventListener('keydown', onKeyPaste, { capture: true })
    container.addEventListener('paste', onPaste, { capture: true })
    window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    return () => {
      if (pasteSuppressionTimerId !== null) {
        window.clearTimeout(pasteSuppressionTimerId)
      }
      container.removeEventListener('keydown', onKeyPaste, { capture: true })
      container.removeEventListener('paste', onPaste, { capture: true })
      window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    }
  }, [isActive, worktreeId, keybindings, forceBracketedMultilineTextPaste, tabId])

  // Why: a click inside the terminal container is a deliberate interaction
  // with the pane — dismiss the attention indicator for this tab and worktree
  // (ghostty "show until interact" semantics). onData already covers
  // keystrokes; pointerdown covers the mouse path, including right-click
  // and middle-click paste, which also count as engagement with the pane.
  //
  // This listener is intentionally NOT gated on `isActive`. In multi-group
  // split layouts (TabGroupPanel), several TerminalPane instances are
  // simultaneously visible but only ONE has `isActive=true` (the focused
  // group's active pane). When the user clicks into a visible-but-inactive
  // split pane, TabGroupPanel's wrapper `onPointerDown={commands.focusGroup}`
  // fires first; focusGroup clears tab-level unread but does NOT call
  // clearWorktreeUnread — so the worktree-level sidebar dot would linger
  // until another interaction. Attaching this listener unconditionally lets
  // the first click dismiss both dots BEFORE focusGroup re-renders the pane
  // as active and the effect deps change.
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      clearTerminalTabUnread(tabId)
      clearWorktreeUnread(worktreeId)
      const paneElement =
        event.target instanceof Element ? event.target.closest('.pane[data-leaf-id]') : null
      const leafId = paneElement?.getAttribute('data-leaf-id')
      if (leafId) {
        clearTerminalPaneUnread(makePaneKey(tabId, leafId))
      }
    }
    container.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, { capture: true })
    }
  }, [tabId, worktreeId, clearTerminalTabUnread, clearTerminalPaneUnread, clearWorktreeUnread])

  const applyTerminalPaneAttention = useCallback(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    applyTerminalPaneAttentionToManager(manager, tabId)
  }, [tabId])

  useLayoutEffect(() => {
    applyTerminalPaneAttention()
    return subscribeTerminalPaneAttention(tabId, applyTerminalPaneAttention)
  }, [tabId, paneCount, applyTerminalPaneAttention])

  // Sync the pane title reservation before paint. Text/banner chrome stays
  // outside xterm's DOM, but xterm must still fit below it so the first
  // terminal row is never hidden under meaningful status UI.
  useLayoutEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    // Show title space only for text/status chrome. Chromeless pane controls
    // float over xterm so untitled panes keep their first row.
    const needsFit = syncSessionRestoredBannerTitleSpace({
      panes: manager.getPanes(),
      paneTitles,
      renamingPaneId,
      sessionRestoredBannerPaneIds
    })
    if (needsFit && (isVisible || shouldMeasureHiddenStartup)) {
      // Why: fitting hidden geometry changes PTY rows and wakes TUIs with
      // SIGWINCH; the visible resume path owns any real layout correction.
      fitPanes(manager)
    }
  }, [
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    isVisible,
    shouldMeasureHiddenStartup
  ])

  const syncPaneTitleOverlayRects = useCallback((): void => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      setPaneTitleOverlayRects({})
      return
    }
    const containerRect = container.getBoundingClientRect()
    const nextRects: Record<number, PaneTitleOverlayRect> = {}
    for (const pane of manager.getPanes()) {
      const paneRect = pane.container.getBoundingClientRect()
      if (paneRect.width <= 0 || paneRect.height <= 0) {
        continue
      }
      nextRects[pane.id] = {
        left: paneRect.left - containerRect.left,
        top: paneRect.top - containerRect.top,
        width: paneRect.width
      }
    }
    setPaneTitleOverlayRects((prev) =>
      arePaneTitleOverlayRectsEqual(prev, nextRects) ? prev : nextRects
    )
  }, [])

  useLayoutEffect(() => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      setPaneTitleOverlayRects({})
      return
    }

    let frame: number | null = null
    const scheduleSync = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(() => {
        frame = null
        syncPaneTitleOverlayRects()
      })
    }

    // Why: the title UI is React-owned now, not a child of the xterm pane.
    // Track pane geometry explicitly so it still appears attached to each
    // split pane while avoiding xterm/Radix focus fights inside the pane DOM.
    syncPaneTitleOverlayRects()
    const resizeObserver = new ResizeObserver(scheduleSync)
    resizeObserver.observe(container)
    for (const pane of manager.getPanes()) {
      resizeObserver.observe(pane.container)
    }
    return () => {
      resizeObserver.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    syncPaneTitleOverlayRects
  ])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    setSessionRestoredBannerPaneIds((prev) => {
      const next = pruneSessionRestoredBannerPaneIds(prev, manager.getPanes())
      return next === prev ? prev : next
    })
  }, [paneCount])

  // Register a capture callback for shutdown. The beforeunload handler in
  // App.tsx calls all registered callbacks to serialize terminal buffers.
  useEffect(() => {
    const captureBuffers = (options?: { includeLocalBuffers?: boolean }): void => {
      const manager = managerRef.current
      const container = containerRef.current
      if (!manager || !container) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length === 0) {
        return
      }
      // Why: setTabLayout REPLACES — it doesn't merge. captureBuffers can
      // run during a transient window (post-remount, just-attached,
      // mid-replay) where xterm hasn't rendered yet so serialize returns 0
      // bytes. Without preservation, that empty pass would wipe a known-good
      // buffer. Merge prior state in for leaves whose live capture came back
      // empty. Same shape as persistLayoutSnapshot.
      const state = useAppStore.getState()
      const existing = state.terminalLayoutsByTabId[tabId]
      const includeLocalBuffers = options?.includeLocalBuffers ?? true
      const shouldCaptureScrollbackBuffers = includeLocalBuffers
        ? true
        : shouldPreserveTerminalScrollbackBuffers(worktreeId, state.repos)
      const layout = captureTerminalShutdownLayout({
        manager,
        container,
        expandedPaneId: expandedPaneIdRef.current,
        paneTransports: paneTransportsRef.current,
        paneTitlesByPaneId: paneTitlesRef.current,
        existingLayout: existing,
        // Why: beforeunload skips local/floating bytes because session payloads
        // immediately prune them; worktree sleep keeps them as defense-in-depth.
        captureBuffers: shouldCaptureScrollbackBuffers,
        clearedScrollbackLeafIds: clearedScrollbackLeafIdsRef.current
      })
      setTabLayout(tabId, layout)
      for (const pane of panes) {
        clearedScrollbackLeafIdsRef.current.delete(pane.leafId)
      }
    }
    shutdownBufferCaptures.set(tabId, captureBuffers)
    return () => {
      // Why: only remove if the entry still points at this closure. A
      // remount could have replaced it before the prior cleanup ran.
      if (shutdownBufferCaptures.get(tabId) === captureBuffers) {
        shutdownBufferCaptures.delete(tabId)
      }
    }
  }, [tabId, worktreeId, setTabLayout])

  useEffect(() => {
    if (renamingPaneId === null) {
      return
    }
    const markPointerBlurIntent = (event: PointerEvent): void => {
      const input = renameInputRef.current
      const target = event.target
      if (input && target instanceof Node && input.contains(target)) {
        return
      }
      renameUserRequestedBlurCommitRef.current = true
    }
    const markKeyboardBlurIntent = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        renameUserRequestedBlurCommitRef.current = true
      }
    }

    document.addEventListener('pointerdown', markPointerBlurIntent, true)
    document.addEventListener('keydown', markKeyboardBlurIntent, true)
    return () => {
      document.removeEventListener('pointerdown', markPointerBlurIntent, true)
      document.removeEventListener('keydown', markKeyboardBlurIntent, true)
    }
  }, [renamingPaneId])

  const handleRenameSubmit = useCallback(() => {
    if (renamingPaneId === null || renameSubmittedRef.current) {
      return
    }
    renameSubmittedRef.current = true
    const trimmed = renameValue.trim()
    if (trimmed.length === 0) {
      if (paneTitlesRef.current[renamingPaneId]) {
        removePaneTitle(renamingPaneId)
      }
      closeRenameSession()
      setRenamingPaneId(null)
      return
    }
    setPaneTitles((prev) => ({ ...prev, [renamingPaneId]: trimmed }))
    // Eagerly update the ref so persistLayoutSnapshot (which reads
    // paneTitlesRef.current) sees the new title immediately, without
    // waiting for React to re-render and assign it during the next
    // render pass.
    paneTitlesRef.current = { ...paneTitlesRef.current, [renamingPaneId]: trimmed }
    const leafId = managerRef.current?.getPanes().find((pane) => pane.id === renamingPaneId)?.leafId
    if (leafId) {
      removedTitleLeafIdsRef.current.delete(leafId)
    }
    closeRenameSession()
    setRenamingPaneId(null)
    // Persist immediately so the title survives restarts.
    persistLayoutSnapshot()
  }, [closeRenameSession, renamingPaneId, renameValue, removePaneTitle, persistLayoutSnapshot])

  const handleRenameCancel = useCallback(() => {
    renameSubmittedRef.current = true
    closeRenameSession()
    setRenamingPaneId(null)
  }, [closeRenameSession])

  const handleRenameBlur = useCallback(() => {
    if (renameSubmittedRef.current) {
      return
    }
    if (renameBlurCommitEnabledRef.current && renameUserRequestedBlurCommitRef.current) {
      handleRenameSubmit()
      return
    }
    if (renamingPaneId === null || renameRefocusFrameRef.current !== null) {
      return
    }

    const sessionId = renameSessionIdRef.current
    const paneId = renamingPaneId
    // Why: the context-menu selection can be followed by a delayed Radix/xterm
    // focus handoff. That synthetic early blur is not a title submission.
    renameRefocusFrameRef.current = requestAnimationFrame(() => {
      renameRefocusFrameRef.current = null
      if (renameSessionIdRef.current !== sessionId || renamingPaneId !== paneId) {
        return
      }
      const input = renameInputRef.current
      if (!input) {
        renameBlurCommitEnabledRef.current = true
        return
      }
      input.focus()
      input.select()
      // Why: if the OS/browser refuses this focus request, still do not
      // submit. Synthetic focus loss is not a title-commit signal.
      renameBlurCommitEnabledRef.current = true
    })
  }, [handleRenameSubmit, renamingPaneId])

  const handleRemoveTitle = useCallback(
    (paneId: number) => removePaneTitle(paneId),
    [removePaneTitle]
  )

  // Auto-focus and select-all in the rename input when the dialog opens.
  // Also reset the submit guard so the new rename session can accept input.
  useEffect(() => {
    if (renamingPaneId === null) {
      return
    }
    const sessionId = renameSessionIdRef.current
    const paneId = renamingPaneId
    renameSubmittedRef.current = false
    renameFocusFrameRef.current = requestAnimationFrame(() => {
      renameFocusFrameRef.current = null
      if (renameSessionIdRef.current !== sessionId || renamingPaneId !== paneId) {
        return
      }
      const input = renameInputRef.current
      if (!input) {
        return
      }
      input.focus()
      input.select()
      renameEnableBlurFrameRef.current = requestAnimationFrame(() => {
        renameEnableBlurFrameRef.current = null
        if (
          renameSessionIdRef.current === sessionId &&
          renamingPaneId === paneId &&
          renameInputRef.current === input &&
          document.activeElement === input
        ) {
          renameBlurCommitEnabledRef.current = true
        }
      })
    })
    return () => cancelPendingRenameFrames()
  }, [cancelPendingRenameFrames, renamingPaneId])

  const contextMenu = useTerminalPaneContextMenu({
    tabId,
    managerRef,
    paneTransportsRef,
    paneCwdRef,
    containerRef,
    worktreeId,
    groupId: quickCommandGroupId,
    fallbackCwd: cwd ?? '',
    toggleExpandPane,
    onRequestClosePane: handleRequestClosePane,
    onClearPaneScrollback: clearPaneScrollback,
    onSetTitle: handleStartRename,
    onClearPaneTitle: handleClearPaneTitleShortcut,
    onPasteError: setTerminalError,
    onAgentSessionForkReady: setAgentSessionFork,
    forceBracketedMultilineTextPaste,
    rightClickToPaste
  })
  const getContextMenuLeafId = useCallback((): string | null => {
    const paneId = contextMenu.menuPaneId
    const manager = managerRef.current
    if (!manager) {
      return null
    }
    if (paneId !== null) {
      return manager.getPanes().find((pane) => pane.id === paneId)?.leafId ?? null
    }
    return manager.getActivePane()?.leafId ?? null
  }, [contextMenu.menuPaneId])
  const contextMenuLeafId = getContextMenuLeafId()
  const contextMenuIsChatView = effectiveChatViewMode && contextMenuLeafId === chatLeafId
  const handleContextMenuToggleNativeChat = useCallback(() => {
    const leafId = getContextMenuLeafId()
    if (!leafId) {
      return
    }
    toggleNativeChatForLeaf(leafId)
  }, [getContextMenuLeafId, toggleNativeChatForLeaf])

  const getMobileOwnedTerminalPtyIds = useCallback((): string[] => {
    const ptyIds = new Set(getMobileFitOverridePtyIds())
    for (const [ptyId, driver] of getAllDrivers()) {
      if (driver.kind === 'mobile') {
        ptyIds.add(ptyId)
      }
    }
    return [...ptyIds]
  }, [])

  const scheduleRestoredTerminalRefit = useCallback((): void => {
    // Why: desktop-fit events can clear runtime state before xterm has repainted;
    // restore actions get one settled-frame pass that does not depend on focus.
    requestAnimationFrame(refitAndRefreshAllTerminalPanes)
    window.setTimeout(refitAndRefreshAllTerminalPanes, 100)
  }, [])

  const restorePaneTerminalFit = useCallback(
    async (pane: ManagedPane, ptyId: string): Promise<void> => {
      // Why: local and remote runtime PTYs use different transports, but the
      // desktop reclaim button should have one visible recovery behavior.
      // Why: the banner was rendered for this PTY; stale portals must disappear
      // before they can reclaim a different terminal that reused this pane slot.
      const currentPtyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      if (currentPtyId !== ptyId) {
        setOverrideTick((n) => n + 1)
        return
      }
      const restored = await restoreTerminalFitToDesktop(ptyId, settingsRef.current ?? undefined)
      if (restored) {
        scheduleRestoredTerminalRefit()
        // Why: after the overlay unmounts, focus would otherwise stay on the
        // removed button/body instead of the terminal the user just reclaimed.
        pane.terminal.focus()
      }
    },
    [scheduleRestoredTerminalRefit]
  )

  const restoreAllTerminalFits = useCallback(
    async (focusPane: ManagedPane): Promise<void> => {
      // Why: a mobile session can leave multiple PTYs held at phone size; bulk
      // restore follows the same reclaim path as the per-pane button.
      const restored = await restoreTerminalFitsToDesktop(
        getMobileOwnedTerminalPtyIds(),
        settingsRef.current ?? undefined
      )
      if (restored) {
        scheduleRestoredTerminalRefit()
        focusPane.terminal.focus()
      }
    },
    [getMobileOwnedTerminalPtyIds, scheduleRestoredTerminalRefit]
  )

  const terminalShouldHandleMiddleClick = useCallback(
    (target: EventTarget | null): target is Node => {
      if (!(target instanceof Element)) {
        return false
      }
      if (target.closest('[data-terminal-search-root]')) {
        return false
      }
      const editable = target.closest(
        'input, textarea, [contenteditable=""], [contenteditable="true"]'
      )
      return !editable || editable.classList.contains('xterm-helper-textarea')
    },
    []
  )

  const getPrimarySelectionMiddleClickPane = useCallback(
    (target: EventTarget | null) => {
      if (!terminalShouldHandleMiddleClick(target)) {
        return null
      }
      const manager = managerRef.current
      if (!manager) {
        return null
      }
      const clickedPane =
        manager.getPanes().find((pane) => pane.container.contains(target)) ??
        manager.getActivePane() ??
        manager.getPanes()[0]
      if (!clickedPane || clickedPane.terminal.modes.mouseTrackingMode !== 'none') {
        return null
      }
      return clickedPane
    },
    [terminalShouldHandleMiddleClick]
  )

  const handlePrimarySelectionMiddleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (event.button !== 1 || !isPrimarySelectionEnabled()) {
        return
      }
      const clickedPane = getPrimarySelectionMiddleClickPane(event.target)
      if (!clickedPane) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      clickedPane.terminal.focus()
      void readPrimarySelectionText().then(async (text) => {
        if (!text) {
          return
        }
        const transport = paneTransportsRef.current.get(clickedPane.id)
        const ptyId = transport?.getPtyId() ?? null
        const isMac = navigator.userAgent.includes('Mac')
        const shortcutPlatform: NodeJS.Platform = isMac
          ? 'darwin'
          : navigator.userAgent.includes('Windows')
            ? 'win32'
            : 'linux'
        const connectionId = getConnectionId(worktreeId) ?? null
        const targetStillMounted = (): boolean => {
          const manager = managerRef.current
          return Boolean(
            manager
              ?.getPanes()
              .some(
                (livePane) =>
                  livePane.id === clickedPane.id && livePane.leafId === clickedPane.leafId
              ) &&
            transport &&
            paneTransportsRef.current.get(clickedPane.id) === transport &&
            transport.isConnected() &&
            transport.getPtyId() === ptyId
          )
        }
        const plan = await planTerminalPasteWithYield({
          text,
          source: 'middle-click',
          target: {
            kind: 'terminal',
            paneId: clickedPane.id,
            leafId: clickedPane.leafId,
            ptyId,
            runtime: resolveTerminalPasteRuntime({
              platform: shortcutPlatform,
              ptyId,
              connectionId,
              remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
              transport
            })
          },
          terminalBracketedPasteMode: clickedPane.terminal.modes.bracketedPasteMode
        })
        const execution = await executeTerminalPastePlan(plan, {
          pasteText: (pasteText, pasteOptions) =>
            pasteTerminalText(clickedPane.terminal, pasteText, pasteOptions),
          writePty: (data) => writeTerminalPastePtyInput(transport, data),
          isTargetCurrent: targetStillMounted,
          canContinue: targetStillMounted
        })
        if (execution.status !== 'pasted') {
          setTerminalError(formatTerminalPasteExecutionError(execution.reason))
          return
        }
        recordTerminalUserInputForLeaf(tabId, clickedPane.leafId)
      })
    },
    [getPrimarySelectionMiddleClickPane, tabId, worktreeId]
  )

  const handlePrimarySelectionAuxClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (
        event.button === 1 &&
        isPrimarySelectionEnabled() &&
        getPrimarySelectionMiddleClickPane(event.target)
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    [getPrimarySelectionMiddleClickPane]
  )

  const activatePaneTitleInteraction = useCallback((paneId: number): void => {
    managerRef.current?.setActivePane(paneId, { focus: false })
  }, [])

  const splitTerminalPaneFromHeader = useCallback(
    (pane: ManagedPane, direction: 'vertical' | 'horizontal') => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      splitTerminalPaneWithInheritedCwd({
        manager,
        getManager: () => managerRef.current,
        paneTransports: paneTransportsRef.current,
        paneCwdMap: paneCwdRef.current,
        fallbackCwd: cwd ?? '',
        pane,
        direction,
        source: 'context_menu'
      })
    },
    [cwd]
  )

  const beginPaneDragFromHeader = useCallback(
    (paneId: number, handle: HTMLElement, event: PointerEvent) => {
      managerRef.current?.beginPaneDragFromPointerDown(paneId, handle, event)
    },
    []
  )

  const effectiveAppearance = settings
    ? resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    : null
  const terminalBackground =
    settings?.terminalColorOverrides?.background ?? effectiveAppearance?.theme?.background
  // Why: app light/dark mode can diverge from the selected terminal theme, so
  // pane-title contrast follows the effective terminal surface instead.
  const titleUsesLightSurface = isTerminalBackgroundLight(terminalBackground, {
    appSurface: effectiveAppearance?.mode,
    backgroundOpacity: settings?.terminalBackgroundOpacity
  })
  const paneTitleBackground =
    resolveOpaqueTerminalBackground(terminalBackground, {
      appSurface: effectiveAppearance?.mode,
      backgroundOpacity: settings?.terminalBackgroundOpacity
    }) ?? (titleUsesLightSurface ? '#ffffff' : '#000000')

  const terminalContentVisible = isVisible || shouldMeasureHiddenStartup
  const hiddenStartupStyle: CSSProperties = shouldMeasureHiddenStartup
    ? { opacity: 0, pointerEvents: 'none' }
    : {}
  const terminalContainerStyle: CSSProperties = {
    // Why: split groups can keep one terminal visible in an unfocused group so
    // users still see its output while typing elsewhere. Hiding on `isActive`
    // blanked the previously focused pane and exposed the white group body.
    display: terminalContentVisible ? 'flex' : 'none',
    // Why: split divider lines intentionally overdraw inside the pane tree.
    // `hidden` reliably clips that pseudo-element paint at the terminal body.
    overflow: 'hidden',
    ...hiddenStartupStyle,
    ['--orca-terminal-divider-color' as string]:
      effectiveAppearance?.dividerColor ?? DEFAULT_TERMINAL_DIVIDER_DARK,
    ['--orca-terminal-divider-color-strong' as string]: normalizeColor(
      effectiveAppearance?.dividerColor,
      DEFAULT_TERMINAL_DIVIDER_DARK
    )
  }

  const activePane = managerRef.current?.getActivePane()
  const managedPanes = managerRef.current?.getPanes() ?? []
  const showSshReconnectOverlay = Boolean(
    isActive &&
    isVisible &&
    sshReconnectTargetId &&
    sshReconnectStatus &&
    sshReconnectStatus !== 'connected'
  )
  const menuPaneHasCustomTitle =
    contextMenu.menuPaneId !== null && Boolean(paneTitles[contextMenu.menuPaneId])
  const chatLeafStillMounted = chatLeafId
    ? managedPanes.some((pane) => pane.leafId === chatLeafId)
    : false
  useEffect(() => {
    const activeLeafId = activePane?.leafId ?? null
    const route = resolveNativeChatLeafRoute({
      isChatViewMode,
      chatLeafId,
      activeLeafId,
      chatLeafStillMounted,
      chatLeafIsEligible: isChatEligibleForLeaf(chatLeafId),
      activeLeafIsEligible: isChatEligibleForLeaf(activeLeafId)
    })
    if (route.chatLeafId !== chatLeafId) {
      setChatLeafId(route.chatLeafId)
    }
    if (route.exitChat && unifiedTabId) {
      // Why: effect replay must not flip terminal mode back to chat.
      setTabViewMode(unifiedTabId, 'terminal')
    }
  }, [
    isChatViewMode,
    chatLeafId,
    activePane?.leafId,
    chatLeafStillMounted,
    isChatEligibleForLeaf,
    unifiedTabId,
    setTabViewMode
  ])
  const chatPane =
    isChatViewMode && chatLeafId
      ? (managedPanes.find((pane) => pane.leafId === chatLeafId) ?? null)
      : null
  const chatPanePtyId = chatPane
    ? (paneTransportsRef.current.get(chatPane.id)?.getPtyId() ?? null)
    : null
  const chatPaneResolvedAgent = chatPane ? resolveTitleAgentForLeaf(chatPane.leafId) : null
  const chatPaneLaunchAgent = nativeChatLaunchAgentForLeaf({
    launchAgent: terminalTab?.launchAgent,
    launchAgentLeafId: getTabWideAgentHintLeafId(),
    leafId: chatPane?.leafId ?? null,
    leafIds: getNativeChatLeafIds()
  })
  const activePaneIsChatLeaf = Boolean(
    isChatViewMode && activePane?.leafId && activePane.leafId === chatLeafId
  )
  // Header toggle gates on the active leaf; the context-menu toggle gates on the
  // leaf the menu was opened over — so a split mixing supported/unsupported
  // agents shows the toggle only on the leaf that can actually render chat.
  const activePaneCanToggleChat = canToggleChatForLeaf(activePane?.leafId ?? null)
  const contextMenuCanToggleChat = canToggleChatForLeaf(contextMenuLeafId)
  return (
    <>
      <div
        ref={setContainerRef}
        className="absolute inset-0 min-h-0 min-w-0"
        data-native-file-drop-target="terminal"
        data-terminal-tab-id={tabId}
        data-terminal-layout-leaf-ids={expectedLayoutLeafIdsAttr}
        data-pane-title-surface={titleUsesLightSurface ? 'light' : 'dark'}
        style={terminalContainerStyle}
        onContextMenuCapture={contextMenu.onContextMenuCapture}
        onMouseDownCapture={handlePrimarySelectionMiddleMouseDown}
        onAuxClickCapture={handlePrimarySelectionAuxClick}
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME) ||
            e.dataTransfer.types.includes(WORKSPACE_FILE_PATHS_MIME)
          ) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(e) => {
          if (
            !e.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME) &&
            !e.dataTransfer.types.includes(WORKSPACE_FILE_PATHS_MIME)
          ) {
            return
          }
          e.preventDefault()
          e.stopPropagation()
          const manager = managerRef.current
          if (!manager) {
            return
          }
          void handleInternalTerminalFileDrop({
            manager,
            paneTransports: paneTransportsRef.current,
            worktreeId,
            tabId,
            cwd,
            dataTransfer: e.dataTransfer,
            dropTarget: e.target
          })
        }}
      />
      {terminalError && isActive && (
        <TerminalErrorToast
          error={terminalError}
          onDismiss={() => setTerminalError(null)}
          onRestartDaemon={() => daemonActions.setPending('restart')}
        />
      )}
      {showSshReconnectOverlay && sshReconnectTargetId && sshReconnectStatus ? (
        <TerminalSshReconnectOverlay
          targetId={sshReconnectTargetId}
          targetLabel={sshReconnectTargetLabel}
          status={sshReconnectStatus}
          targetRemoved={sshReconnectTargetRemoved}
          worktreeId={worktreeId}
          sshOwnerEnvironmentId={sshReconnectEnvironmentId}
        />
      ) : null}
      <DaemonActionDialog api={daemonActions} />
      {isActive && (
        <TerminalSessionStateSaveFailureDialog
          open={sessionStateSaveFailureOpen}
          onDismiss={() => setSessionStateSaveFailureOpen(false)}
          onOpenSpaceAnalyzer={openDiskSpaceAnalyzer}
        />
      )}
      {activePane?.container &&
        createPortal(
          <TerminalSearch
            isOpen={searchOpen}
            onClose={() => setSearchOpen(false)}
            searchAddon={activePane.searchAddon ?? null}
            searchStateRef={searchStateRef}
          />,
          activePane.container
        )}
      <SessionRestoredBannerPortals
        panes={managerRef.current?.getPanes() ?? []}
        paneIds={sessionRestoredBannerPaneIds}
      />
      {effectiveChatViewMode && chatPane?.container
        ? createPortal(
            <div className="absolute inset-0 z-10 flex min-h-0 min-w-0 bg-background">
              <NativeChatView
                terminalTabId={tabId}
                paneKey={makePaneKey(tabId, chatPane.leafId)}
                targetPtyId={chatPanePtyId}
                launchAgent={chatPaneLaunchAgent}
                resolvedAgent={chatPaneResolvedAgent}
                onSwitchToTerminal={() => toggleNativeChatForLeaf(chatPane.leafId)}
                contextMenuActions={{
                  onSplitRight: () => contextMenu.runForPane(chatPane.id, contextMenu.onSplitRight),
                  onSplitDown: () => contextMenu.runForPane(chatPane.id, contextMenu.onSplitDown),
                  canEqualizePaneSizes: managedPanes.length > 1 && expandedPaneId === null,
                  onEqualizePaneSizes: () =>
                    contextMenu.runForPane(chatPane.id, contextMenu.onEqualizePaneSizes),
                  canExpandPane: managedPanes.length > 1,
                  isPaneExpanded: expandedPaneId === chatPane.id,
                  onToggleExpand: () =>
                    contextMenu.runForPane(chatPane.id, contextMenu.onToggleExpand),
                  onForkAgentSession: () =>
                    void contextMenu.runForPane(chatPane.id, contextMenu.onForkAgentSession),
                  onSetTitle: () => contextMenu.runForPane(chatPane.id, contextMenu.onSetTitle),
                  onCopyTerminalId: () =>
                    void contextMenu.runForPane(chatPane.id, contextMenu.onCopyTerminalId),
                  onCopyPaneId: () =>
                    void contextMenu.runForPane(chatPane.id, contextMenu.onCopyPaneId),
                  canClosePane: managedPanes.length > 1,
                  onClosePane: () => contextMenu.runForPane(chatPane.id, contextMenu.onClosePane)
                }}
              />
            </div>,
            chatPane.container,
            `native-chat-${tabId}-${chatPane.leafId}`
          )
        : null}
      <TerminalContextMenu
        open={contextMenu.open}
        onOpenChange={contextMenu.setOpen}
        menuPoint={contextMenu.point}
        menuOpenedAtRef={contextMenu.menuOpenedAtRef}
        canClosePane={contextMenu.paneCount > 1}
        canExpandPane={contextMenu.paneCount > 1}
        canEqualizePaneSizes={contextMenu.paneCount > 1 && expandedPaneId === null}
        menuPaneIsExpanded={
          contextMenu.menuPaneId !== null && contextMenu.menuPaneId === expandedPaneId
        }
        onCopy={() => void contextMenu.onCopy()}
        onPaste={() => void contextMenu.onPaste()}
        onSplitRight={contextMenu.onSplitRight}
        onSplitDown={contextMenu.onSplitDown}
        keybindings={keybindings}
        onEqualizePaneSizes={contextMenu.onEqualizePaneSizes}
        onClosePane={contextMenu.onClosePane}
        onClearScreen={contextMenu.onClearScreen}
        onForkAgentSession={() => void contextMenu.onForkAgentSession()}
        canToggleNativeChat={contextMenuCanToggleChat}
        isNativeChatView={contextMenuIsChatView}
        onToggleNativeChat={handleContextMenuToggleNativeChat}
        onCopyAgentSessionContext={() => void contextMenu.onCopyAgentSessionContext()}
        repoQuickCommands={repoQuickCommands}
        globalQuickCommands={globalQuickCommands}
        quickCommandRepoLabel={quickCommandRepoLabel}
        onQuickCommand={contextMenu.onQuickCommand}
        onAddQuickCommand={
          quickCommandRepoId
            ? () => openQuickCommandEditor({ type: 'repo', repoId: quickCommandRepoId })
            : () => openQuickCommandEditor({ type: 'global' })
        }
        onToggleExpand={contextMenu.onToggleExpand}
        onSetTitle={contextMenu.onSetTitle}
        onClearPaneTitle={contextMenu.onClearPaneTitle}
        canClearPaneTitle={menuPaneHasCustomTitle}
        onCopyTerminalId={() => void contextMenu.onCopyTerminalId()}
        onCopyPaneId={contextMenu.onCopyPaneId}
      />
      {/* Why: repos is a broad store slice; only subscribe while the editor is visible. */}
      {quickCommandEditorOpen ? (
        <TerminalQuickCommandEditorDialog
          command={quickCommandDraft}
          onOpenChange={setQuickCommandEditorOpen}
          onSave={saveQuickCommand}
        />
      ) : null}
      <TerminalAgentSessionForkDialog
        open={agentSessionFork !== null}
        fork={agentSessionFork}
        onOpenChange={(open) => {
          if (!open) {
            setAgentSessionFork(null)
          }
        }}
      />
      <TerminalPaneHeaderOverlay
        tabId={tabId}
        worktreeId={worktreeId}
        cwd={cwd ?? ''}
        showAlwaysOnHeaders={isActive && terminalContentVisible}
        paneCount={paneCount}
        activePaneId={activePane?.id}
        panes={managedPanes}
        paneTitles={paneTitles}
        paneTitleOverlayRects={paneTitleOverlayRects}
        renamingPaneId={renamingPaneId}
        renameValue={renameValue}
        renameInputRef={renameInputRef}
        titleUsesLightSurface={titleUsesLightSurface}
        paneTitleBackground={paneTitleBackground}
        terminalContentVisible={terminalContentVisible}
        hiddenStartupStyle={hiddenStartupStyle}
        managerRef={managerRef}
        paneTransportsRef={paneTransportsRef}
        canToggleNativeChat={activePaneCanToggleChat}
        isChatViewMode={activePaneIsChatLeaf}
        onToggleNativeChat={handleToggleNativeChat}
        onSplitPane={splitTerminalPaneFromHeader}
        onBeginPaneDrag={beginPaneDragFromHeader}
        onActivatePaneTitleInteraction={activatePaneTitleInteraction}
        onPaneTitleContextMenu={contextMenu.onPaneTitleContextMenu}
        onStartRename={handleStartRename}
        onRemoveTitle={handleRemoveTitle}
        onClosePane={handleRequestClosePane}
        onRenameValueChange={setRenameValue}
        onRenameSubmit={handleRenameSubmit}
        onRenameCancel={handleRenameCancel}
        onRenameBlur={handleRenameBlur}
      />
      {managedPanes.map((pane) => {
        // Why: pane IDs can collide across tabs (e.g. tab 0 pane 1 and tab 1
        // pane 1). Using the transport's actual ptyId avoids showing banners
        // on the wrong pane when IDs overlap.
        const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
        if (!ptyId) {
          return null
        }
        // Why: two-state lock UI. (1) Driver is mobile → presence-lock,
        // input paused (docs/mobile-presence-lock.md). (2) No mobile driver
        // but a phone-fit override is still in place → indefinite hold
        // (docs/mobile-fit-hold.md). MobileDriverOverlay owns the visual
        // treatment and collapse-to-chip state; both branches share the
        // same local/remote desktop-restore route.
        const driver = getDriverForPty(ptyId)
        const fitMode = getFitOverrideForPty(ptyId)?.mode ?? null
        const hasFitOverride = fitMode === 'mobile-fit'
        if (!shouldShowMobileDriverOverlay(driver.kind, fitMode)) {
          return null
        }
        // Why: only the pane replaced by native chat should hide terminal-owned
        // presence-lock/phone-fit chrome; sibling splits remain normal terminals.
        const paneSurface =
          effectiveChatViewMode && pane.leafId === chatLeafId ? 'chat' : 'terminal'
        if (shouldChatTakeOverMobileSurface(paneSurface)) {
          return null
        }
        return createPortal(
          <MobileDriverOverlay
            key={`mobile-driver-${pane.id}-${ptyId}`}
            driver={driver}
            hasFitOverride={hasFitOverride}
            rootClassName="mobile-driver-banner"
            onAction={() => restorePaneTerminalFit(pane, ptyId)}
            onAllAction={() => restoreAllTerminalFits(pane)}
          />,
          pane.container,
          `mobile-driver-banner-${pane.id}`
        )
      })}
      <CloseTerminalDialog
        open={pendingCloseConfirmation !== null}
        copyKind={pendingCloseConfirmation?.copyKind}
        onCancel={handleCancelClose}
        onConfirm={handleConfirmClose}
      />
    </>
  )
}
