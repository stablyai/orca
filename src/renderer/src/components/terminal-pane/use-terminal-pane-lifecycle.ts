/* eslint-disable max-lines -- Why: terminal pane lifecycle wiring is intentionally co-located so PTY attach, theme sync, and runtime graph publication remain consistent for live terminals. */
import { useEffect, useRef } from 'react'
import type { IDisposable, Terminal } from '@xterm/xterm'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import {
  PaneManager,
  type PaneExternalDropHandler,
  type PaneExternalDropResolver
} from '@/lib/pane-manager/pane-manager'
import { consumePendingWebRuntimeSplitMirrorTelemetry } from '@/runtime/web-runtime-session'
import {
  normalizeTerminalFastScrollSensitivity,
  normalizeTerminalScrollSensitivity,
  resolveTerminalCursorInactiveStyle
} from '@/lib/pane-manager/pane-terminal-options'
import { normalizeDesktopTerminalScrollbackRows } from '../../../../shared/terminal-scrollback-policy'
import {
  configureTerminalOutputBacklogCap,
  writeTerminalOutput
} from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { normalizeTerminalLineHeight } from '../../../../shared/terminal-line-height-settings'
import { normalizeTerminalTuiMouseWheelMultiplier } from '@/lib/pane-manager/pane-terminal-mouse-wheel'
import { buildWindowsPtyCompatibilityOptions } from '@/lib/pane-manager/windows-pty-compatibility'
import { buildTerminalKeyboardProtocolOptions } from '@/lib/pane-manager/terminal-keyboard-protocol'
import { resolvePaneKeyboardProtocolAgent } from './terminal-keyboard-protocol-pane-agent'
import { useAppStore } from '@/store'
import {
  createFilePathLinkProvider,
  getTerminalFileOpenHint,
  getTerminalUrlOpenHint,
  installFilePathLinkClickFallback
} from './terminal-link-handlers'
import { createTerminalHandleLinkProvider } from './terminal-handle-links'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import { handleOscLink } from './terminal-osc-link-routing'
import { handleTerminalWebLinkClick } from './terminal-web-link-click'
import {
  installHttpLinkClickFallback,
  type TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'
import { resolveLocalhostHttpLinkDisplayUrl } from '@/lib/http-link-routing'
import type {
  GlobalSettings,
  SetupSplitDirection,
  TerminalTab,
  TerminalLayoutSnapshot,
  TuiAgent
} from '../../../../shared/types'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import {
  buildFontFamily,
  normalizeTerminalLayoutSnapshot,
  RESET_KITTY_KEYBOARD_PROTOCOL,
  replayTerminalLayout,
  restoreScrollbackBuffers
} from './layout-serialization'
import { resolveTerminalLayoutActiveLeafId } from './terminal-layout-leaf-ids'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { applyExpandedLayoutTo, restoreExpandedLayoutFrom } from './expand-collapse'
import { applyTerminalAppearance, installMode2031Handlers } from './terminal-appearance'
import { pushMode2031SeedReply } from './terminal-mode-2031-replies'
import { handleOsc52ClipboardRequest } from './osc52-clipboard'
import { showOsc52ClipboardBlockedToast } from './osc52-clipboard-blocked-toast'
import { parseOsc7 } from './parse-osc7'
import { guardParserHandler } from './terminal-parser-handler-guard'
import { resolveTerminalJisYenInput } from './terminal-jis-yen-input'
import { installTerminalImeCompositionTracker } from './terminal-ime-composition-tracker'
import { installTerminalImeLinuxCandidateState } from './terminal-ime-linux-candidate-state'
import {
  armTerminalImePendingCandidateKeyRelease,
  clearTerminalImePendingCandidateKeyRelease,
  createTerminalImePendingCandidateKeyReleases,
  shouldApplyTerminalImePendingCandidateKeyRelease
} from './terminal-ime-candidate-key-release-guard'
import {
  DISABLED_MAC_NATIVE_TEXT_INPUT_SOURCE_FEATURES,
  getMacNativeTextInputSourceTracker
} from './terminal-ime-input-source'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'
import {
  shouldBypassXtermKeyboardEvent,
  shouldHandleTerminalInterruptKeyboardEvent,
  shouldPreventDefaultTerminalImeCandidateKey,
  shouldSuppressTerminalImeKeyboardEvent,
  shouldSuppressTerminalInterruptKeyup,
  shouldSuppressTerminalModifierKeyboardEvent,
  TERMINAL_INTERRUPT_INPUT
} from './xterm-bypass-policy'
import type { PaneCwdMap } from './resolve-split-cwd'
import { installMouseHideWhileTyping } from './mouse-hide-while-typing'
import type { EffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'
import { resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { connectPanePty } from './pty-connection'
import type { PtyTransport } from './pty-transport'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import {
  reconcileMissingSessions,
  type ReconcilableBinding
} from './terminal-dead-session-reconcile'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { getConnectionId } from '@/lib/connection-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isPaneReplaying, type ReplayingPanesRef } from './replay-guard'
import { fitAndFocusPanes, fitPanes } from './pane-helpers'
import { markTerminalPinnedViewport } from '@/lib/pane-manager/terminal-scroll-intent'
import { syncTerminalScrollIntentSoon } from '@/lib/pane-manager/terminal-scroll-intent-settle'
import { registerRuntimeTerminalTab, scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { captureParkedTerminalPaneCandidates } from './terminal-parked-tab-watchers'
import { e2eConfig } from '@/lib/e2e-config'
import {
  PRIMARY_SELECTION_MAX_LENGTH,
  isPrimarySelectionEnabled,
  setPrimarySelectionText
} from '@/lib/primary-selection'
import {
  SPLIT_TERMINAL_PANE_EVENT,
  CLOSE_TERMINAL_PANE_EVENT,
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type SplitTerminalPaneDetail,
  type CloseTerminalPaneDetail,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import { acquireWebviewsDragPassthrough } from '../browser-pane/webview-registry'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { seedStartupSessionRestoredBanner } from './session-restored-banner-pane-state'
import {
  resolveTabTitleAfterPaneClose,
  shouldClearLaunchAgentForClosedPane
} from './terminal-pane-close-identity'

export function resetTerminalKeyboardProtocolAfterInterrupt(terminal: Terminal): void {
  // Guarded output path so a throwing xterm can't escape the key handler.
  writeTerminalOutput(terminal, RESET_KITTY_KEYBOARD_PROTOCOL, {
    foreground: true,
    // Queue the reset so it can't flush a PTY backlog inside the key handler.
    latencySensitive: false
  })
}

export function recordRuntimeCreatedTerminalPaneSplit(
  createdPane: unknown,
  args: {
    source: TerminalPaneSplitSource
    direction: 'vertical' | 'horizontal'
    telemetrySuppressed?: boolean
  }
): boolean {
  return recordCreatedTerminalPaneSplit(createdPane, args)
}

type TerminalScrollbackPaneManager = {
  getPanes(): { terminal: Pick<Terminal, 'options'> }[]
}

export function applyTerminalScrollbackRowsToMountedPanes(
  manager: TerminalScrollbackPaneManager,
  rows: number
): void {
  for (const pane of manager.getPanes()) {
    if (pane.terminal.options.scrollback !== rows) {
      pane.terminal.options.scrollback = rows
    }
  }
}

function extractUncHost(value: string | undefined): string | null {
  const match = /^(?:\\\\|\/\/)([^\\/]+)/.exec(value ?? '')
  return match?.[1] || null
}

function reportActiveRendererPtyForPane(
  paneTransports: Map<number, PtyTransport>,
  activePaneId: number | null
): void {
  for (const [paneId, transport] of paneTransports) {
    const ptyId = transport.getPtyId()
    if (!ptyId || ptyId.startsWith('remote:')) {
      continue
    }
    window.api.pty.setActiveRendererPty?.(ptyId, activePaneId === paneId)
  }
}

async function formatTerminalUrlTooltip(url: string, openLinkHint: string): Promise<string | null> {
  const labeledUrl = await resolveLocalhostHttpLinkDisplayUrl(url)
  if (!labeledUrl) {
    return null
  }
  try {
    const originalHost = new URL(url).host
    return `${labeledUrl} (${originalHost}; ${openLinkHint})`
  } catch {
    return `${labeledUrl} (${openLinkHint})`
  }
}

type UseTerminalPaneLifecycleDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
  startup?: {
    command: string
    /** Startup input needing xterm paste semantics before the submit Enter. */
    delivery?: 'terminal-paste'
    startupCommandDelivery?: StartupCommandDelivery
    env?: Record<string, string>
    envToDelete?: string[]
    launchConfig?: SleepingAgentLaunchConfig
    resumeProviderSession?: AgentProviderSessionMetadata
    launchToken?: string
    launchAgent?: TuiAgent
    draftPrompt?: string
    /** Initial prompt-start status for agents that lack native prompt hooks. */
    initialAgentStatus?: { agent: TuiAgent; prompt: string }
    /** Telemetry for `agent_started`; forwarded to `pty:spawn` so main fires it only after spawn succeeds. */
    telemetry?: EventProps<'agent_started'>
    /** Show the restored-session banner when this startup command mounts. */
    showSessionRestoredBanner?: boolean
    /** Initial startup may be paired with a setup split that changes its grid. */
    waitForSetupSplitDirection?: SetupSplitDirection
  } | null
  /** Split pane runs the setup command so the main terminal stays interactive. */
  setupSplit?: {
    command: string
    env?: Record<string, string>
    direction: SetupSplitDirection
  } | null
  /** Split pane runs the repo's issue-automation command with the issue number interpolated. */
  issueCommandSplit?: { command: string; env?: Record<string, string> } | null
  isActive: boolean
  isVisible: boolean
  systemPrefersDark: boolean
  settings: GlobalSettings | null | undefined
  settingsRef: React.RefObject<GlobalSettings | null | undefined>
  requestOpenLinksInAppPreference: TerminalLinkRoutingPreferenceRequester
  /** Resolved Option-as-Alt: `'auto'` already mapped to `'true'|'false'` via the layout probe, which lives outside the settings store. */
  effectiveMacOptionAsAlt: EffectiveMacOptionAsAlt
  effectiveMacOptionAsAltRef: React.RefObject<EffectiveMacOptionAsAlt>
  initialLayoutRef: React.RefObject<TerminalLayoutSnapshot>
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  expandedStyleSnapshotRef: React.MutableRefObject<
    Map<HTMLElement, { display: string; flex: string }>
  >
  paneFontSizesRef: React.RefObject<Map<number, number>>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  /** Per-pane live cwd (from the OSC 7 handler); read synchronously by split handlers for cache hits. */
  paneCwdRef: React.RefObject<PaneCwdMap>
  paneMode2031Ref: React.RefObject<Map<number, boolean>>
  paneKittyKeyboardModesRef: React.RefObject<Map<number, TerminalKittyKeyboardModeTracker>>
  paneLastThemeModeRef: React.RefObject<Map<number, 'dark' | 'light'>>
  panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>
  replayingPanesRef: ReplayingPanesRef
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  onPtyExitRef: React.RefObject<(ptyId: string) => void>
  onAgentExitedRef: React.RefObject<(leafId: string) => void>
  onPtyErrorRef?: React.RefObject<(paneId: number, message: string) => void>
  onPtyRecoveryStateRef?: React.RefObject<
    (paneId: number, state: PtyTransportRecoveryState | null) => void
  >
  clearTabPtyId: (tabId: string, ptyId: string) => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  isPtyShutdownPending: (ptyId: string) => boolean
  updateTabTitle: (tabId: string, title: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  updateTabPtyId: (tabId: string, ptyId: string, replacedPtyId?: string) => void
  markWorktreeUnread: (worktreeId: string) => void
  markTerminalTabUnread: (tabId: string) => void
  markTerminalPaneUnread: (paneKey: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
  onShowSessionRestoredBanner: (paneId: number) => void
  dispatchNotification: (event: {
    source: 'terminal-bell' | 'agent-task-complete'
    terminalTitle?: string
    paneKey?: string
    agentStatusSnapshot?: ParsedAgentStatusPayload
    suppressOsNotification?: boolean
  }) => void
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
  clearExitedPanePtyLayoutBinding: (paneId: number, exitedPtyId: string) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setExpandedPane: (paneId: number | null) => void
  syncExpandedLayout: () => void
  persistLayoutSnapshot: () => void
  setPaneTitles: React.Dispatch<React.SetStateAction<Record<number, string>>>
  paneTitlesRef: React.RefObject<Record<number, string>>
  setRenamingPaneId: React.Dispatch<React.SetStateAction<number | null>>
  // Why: managerRef.getPanes() isn't reactive, so this dispatcher ticks effects when panes split/close.
  setPaneCount: React.Dispatch<React.SetStateAction<number>>
  // Why: same pane count != same geometry (drag-reorder moves without resizing), so overlay rects need a tick.
  setPaneLayoutRevision: React.Dispatch<React.SetStateAction<number>>
  resolveExternalPaneDropTarget?: PaneExternalDropResolver
  onExternalPaneDrop?: PaneExternalDropHandler
}

export function suppressIntentionalPaneCloseExit(
  transport: Pick<PtyTransport, 'getPtyId'> | null | undefined,
  suppressPtyExit: (ptyId: string) => void
): string | null {
  const ptyId = transport?.getPtyId() ?? null
  if (ptyId) {
    suppressPtyExit(ptyId)
  }
  return ptyId
}

export function mapRestoredPaneTitlesByPaneId(
  savedTitles: Record<string, string> | undefined,
  restoredPaneByLeafId: ReadonlyMap<string, number>
): Record<number, string> {
  if (!savedTitles) {
    return {}
  }

  const restored: Record<number, string> = {}
  for (const [oldLeafId, title] of Object.entries(savedTitles)) {
    const newPaneId = restoredPaneByLeafId.get(oldLeafId)
    if (newPaneId != null && title) {
      restored[newPaneId] = title
    }
  }
  return restored
}

function terminalSelectionExceedsPrimaryLimit(terminal: Terminal): boolean {
  const range = terminal.getSelectionPosition()
  if (!range) {
    return false
  }
  const startY = Math.min(range.start.y, range.end.y)
  const endY = Math.max(range.start.y, range.end.y)
  const rowSpan = endY - startY
  const cellEstimate =
    rowSpan === 0
      ? Math.abs(range.end.x - range.start.x)
      : rowSpan * terminal.cols + Math.abs(range.end.x - range.start.x)
  return cellEstimate > PRIMARY_SELECTION_MAX_LENGTH
}

function hydrateTerminalScrollbackRefs(layout: TerminalLayoutSnapshot): {
  layout: TerminalLayoutSnapshot
  hydrated: boolean
} {
  const refs = layout.scrollbackRefsByLeafId
  if (!refs || Object.keys(refs).length === 0) {
    return { layout, hydrated: false }
  }

  const buffers = { ...layout.buffersByLeafId }
  let hydrated = false
  for (const [leafId, ref] of Object.entries(refs)) {
    if (buffers[leafId] !== undefined) {
      continue
    }
    try {
      const buffer = window.api.session.readTerminalScrollback({ ref })
      if (buffer) {
        buffers[leafId] = buffer
        hydrated = true
      }
    } catch {
      // Best-effort restore; failed snapshot reads should not block terminal mount.
    }
  }

  return hydrated
    ? { layout: { ...layout, buffersByLeafId: buffers }, hydrated }
    : { layout, hydrated }
}

export function resolveQueuedInitialCwd(
  queuedInitialCwd: string | null | undefined,
  consumeTabInitialCwd: () => string | null,
  defaultTabCwd: string
): { queuedInitialCwd: string | null; startupCwd: string } {
  const nextQueuedInitialCwd =
    queuedInitialCwd === undefined ? consumeTabInitialCwd() : queuedInitialCwd
  return {
    queuedInitialCwd: nextQueuedInitialCwd,
    startupCwd: nextQueuedInitialCwd ?? defaultTabCwd
  }
}

export function clearQueuedInitialCwdAfterFirstPane(
  queuedInitialCwd: string | null | undefined,
  defaultTabCwd: string,
  currentPtyCwd: string
): { queuedInitialCwd: string | null | undefined; ptyCwd: string } {
  if (!queuedInitialCwd) {
    return { queuedInitialCwd, ptyCwd: currentPtyCwd }
  }
  return { queuedInitialCwd: null, ptyCwd: defaultTabCwd }
}

export function resolvePaneLinkCwd(
  paneCwdMap: PaneCwdMap,
  paneId: number,
  fallbackCwd: string
): string {
  return paneCwdMap.get(paneId)?.cwd ?? fallbackCwd
}

export function resolvePaneSeedCwd(splitPaneCwd: string | undefined, fallbackCwd: string): string {
  return splitPaneCwd ?? fallbackCwd
}

type SplitStartupPayload = { command: string; env?: Record<string, string> }

type SplitWithStartupDeps = {
  startup?: SplitStartupPayload | null
}

function resolveTerminalHomePathFromEnv(env: Record<string, string> | undefined): string | null {
  const home = env?.HOME?.trim()
  if (home) {
    return home
  }
  const userProfile = env?.USERPROFILE?.trim()
  if (userProfile) {
    return userProfile
  }
  const homeDrive = env?.HOMEDRIVE?.trim()
  const homePath = env?.HOMEPATH?.trim()
  return homeDrive && homePath ? `${homeDrive}${homePath}` : null
}

/** Scopes `deps.startup` to a single call of `splitPane()`, clearing it in `finally` so later splits do not replay the payload. */
export function splitPaneWithOneShotStartup<TPane>(
  deps: SplitWithStartupDeps,
  startup: SplitStartupPayload,
  splitPane: () => TPane
): TPane {
  // Why: startup is only for this split's pane; reset in finally so later splits never replay setup/issue commands. Assumes splitPane reads it synchronously.
  deps.startup = startup
  try {
    return splitPane()
  } finally {
    deps.startup = null
  }
}

export function shouldDetachPaneTransportOnUnmount(args: {
  tabStillExists: boolean
  tabId: string
  ptyId: string | null
  worktreeTabs: readonly TerminalTab[] | undefined
}): boolean {
  // Why: teardown is renderer-only (closeTab/pane-close owns provider shutdown); destroy only pending, ID-less spawns.
  return Boolean(args.ptyId)
}

/**
 * Self-gating dead-session reconcile: true only on resume (hidden→visible), since the isVisible effect fires on both true and false.
 */
export function isTerminalPaneVisibilityResume(args: {
  previousIsVisible: boolean | null
  isVisible: boolean
}): boolean {
  return args.previousIsVisible === false && args.isVisible
}

type TerminalPaneVisibilitySnapshot = {
  tabId: string
  cwd: string | null | undefined
  isVisible: boolean
}

export function getPreviousVisibleForTerminalPane(args: {
  previous: TerminalPaneVisibilitySnapshot | null
  tabId: string
  cwd: string | null | undefined
}): boolean | null {
  if (args.previous?.tabId !== args.tabId || args.previous.cwd !== args.cwd) {
    return null
  }
  return args.previous.isVisible
}

/** Wires mounted terminal panes to renderer state and terminal event handling. */
export function useTerminalPaneLifecycle({
  tabId,
  worktreeId,
  cwd,
  startup,
  setupSplit,
  issueCommandSplit,
  isActive,
  isVisible,
  systemPrefersDark,
  settings,
  settingsRef,
  requestOpenLinksInAppPreference,
  effectiveMacOptionAsAlt,
  effectiveMacOptionAsAltRef,
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
  onAgentExitedRef,
  onPtyErrorRef,
  onPtyRecoveryStateRef,
  clearTabPtyId,
  consumeSuppressedPtyExit,
  isPtyShutdownPending,
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
  onShowSessionRestoredBanner,
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
  onExternalPaneDrop
}: UseTerminalPaneLifecycleDeps): void {
  const terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
    settings?.terminalScrollbackRows
  )
  // Why here: backlog cap scales with the scrollback setting; set it where the setting is read to stay in lockstep.
  configureTerminalOutputBacklogCap(settings?.terminalScrollbackRows)
  const systemPrefersDarkRef = useRef(systemPrefersDark)
  systemPrefersDarkRef.current = systemPrefersDark
  const previousVisibleForReconcileRef = useRef<TerminalPaneVisibilitySnapshot | null>(null)
  const linkProviderDisposablesRef = useRef(new Map<number, IDisposable>())
  const terminalHandleLinkDisposablesRef = useRef(new Map<number, IDisposable>())
  const fileLinkClickFallbackDisposablesRef = useRef(new Map<number, IDisposable>())
  const httpLinkClickFallbackDisposablesRef = useRef(new Map<number, IDisposable>())
  // Why: read settingsRef at fire time so toggling "copy on select" applies without recreating panes.
  const selectionDisposablesRef = useRef(new Map<number, IDisposable>())
  const selectionCaptureTimersRef = useRef(new Map<number, number>())
  const mode2031DisposablesRef = useRef(new Map<number, IDisposable[]>())
  const mode2031SeedAttemptTokensRef = useRef(new Map<number, symbol>())
  const osc52DisposablesRef = useRef(new Map<number, IDisposable>())
  const osc7DisposablesRef = useRef(new Map<number, IDisposable>())
  const mouseHideDisposablesRef = useRef(new Map<number, IDisposable>())
  const imeCompositionDisposablesRef = useRef(new Map<number, IDisposable>())
  const imeNativeTextForwarderDisposablesRef = useRef(new Map<number, IDisposable>())
  const queuedInitialCwdRef = useRef<string | null | undefined>(undefined)
  const restoredViewportBlankingPanesRef = useRef(new Set<number>())

  const applyAppearance = (manager: PaneManager): void => {
    const currentSettings = settingsRef.current
    if (!currentSettings) {
      return
    }
    applyTerminalAppearance(
      manager,
      currentSettings,
      systemPrefersDarkRef.current,
      paneFontSizesRef.current,
      paneTransportsRef.current,
      effectiveMacOptionAsAltRef.current,
      paneMode2031Ref.current,
      paneLastThemeModeRef.current
    )
  }

  const pushMode2031ForPane = (paneId: number): void => {
    const attemptToken = Symbol()
    mode2031SeedAttemptTokensRef.current.set(paneId, attemptToken)
    pushMode2031SeedReply(paneId, {
      hasPane: (candidateId) =>
        managerRef.current?.getPanes().some((pane) => pane.id === candidateId) === true,
      isSubscribed: (candidateId) => paneMode2031Ref.current.get(candidateId) === true,
      // Why: an older connect retry must not answer a later resubscription.
      isCurrentAttempt: (candidateId) =>
        mode2031SeedAttemptTokensRef.current.get(candidateId) === attemptToken,
      getTransport: (candidateId) => paneTransportsRef.current.get(candidateId),
      getMode: () => {
        const currentSettings = settingsRef.current
        return currentSettings
          ? resolveEffectiveTerminalAppearance(currentSettings, systemPrefersDarkRef.current).mode
          : null
      },
      recordMode: (candidateId, mode) => paneLastThemeModeRef.current.set(candidateId, mode),
      schedule: (callback, delayMs) => {
        window.setTimeout(callback, delayMs)
      }
    })
  }

  // Initialize PaneManager instance once
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const expandedStyleSnapshots = expandedStyleSnapshotRef.current
    const paneTransports = paneTransportsRef.current
    const panePtyBindings = panePtyBindingsRef.current
    const linkDisposables = linkProviderDisposablesRef.current
    const terminalHandleLinkDisposables = terminalHandleLinkDisposablesRef.current
    const fileLinkClickFallbackDisposables = fileLinkClickFallbackDisposablesRef.current
    const httpLinkClickFallbackDisposables = httpLinkClickFallbackDisposablesRef.current
    const selectionDisposables = selectionDisposablesRef.current
    const selectionCaptureTimers = selectionCaptureTimersRef.current
    const mouseHideDisposables = mouseHideDisposablesRef.current
    const imeCompositionDisposables = imeCompositionDisposablesRef.current
    const imeNativeTextForwarderDisposables = imeNativeTextForwarderDisposablesRef.current
    const worktreePath =
      useAppStore
        .getState()
        .allWorktrees()
        .find((candidate) => candidate.id === worktreeId)?.path ??
      cwd ??
      ''
    const defaultTabCwd = cwd ?? worktreePath
    const initialCwdResolution = resolveQueuedInitialCwd(
      queuedInitialCwdRef.current,
      () => useAppStore.getState().consumeTabInitialCwd(tabId),
      defaultTabCwd
    )
    queuedInitialCwdRef.current = initialCwdResolution.queuedInitialCwd
    const startupCwd = initialCwdResolution.startupCwd
    const terminalHomePath = resolveTerminalHomePathFromEnv(startup?.env)
    const getPaneLinkCwd = (paneId: number): string =>
      resolvePaneLinkCwd(paneCwdRef.current, paneId, startupCwd)
    // Why: lifecycle-scoped cache for cross-SSH/runtime existence probes; may hold temporarily stale entries.
    const pathExistsCache = new Map<string, boolean>()
    const linkDeps: LinkHandlerDeps = {
      worktreeId,
      worktreePath,
      startupCwd,
      getPaneLinkCwd,
      terminalHomePath,
      managerRef,
      linkProviderDisposablesRef,
      pathExistsCache,
      getRuntimeEnvironmentIdForPane: (paneId) => {
        const ptyId = paneTransportsRef.current.get(paneId)?.getPtyId()
        return ptyId ? getRemoteRuntimePtyEnvironmentId(ptyId) : null
      }
    }
    let resizeRaf: number | null = null
    const queueResizeAll = (focusActive: boolean): void => {
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf)
      }
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        const manager = managerRef.current
        if (!manager) {
          return
        }
        if (focusActive) {
          fitAndFocusPanes(manager)
          return
        }
        fitPanes(manager)
      })
    }

    const syncCanExpandState = (): void => {
      const paneCount = managerRef.current?.getPanes().length ?? 1
      setTabCanExpandPane(tabId, paneCount > 1)
    }

    // Why: PaneManager's pane list is an imperative ref, so publish count to React state so effects re-run on split/close.
    const syncPaneCount = (): void => {
      setPaneCount(managerRef.current?.getPanes().length ?? 0)
    }

    const syncPaneLayoutRevision = (): void => {
      setPaneLayoutRevision((revision) => revision + 1)
    }

    const normalizedInitialLayout = normalizeTerminalLayoutSnapshot(initialLayoutRef.current)
    if (normalizedInitialLayout.changed) {
      initialLayoutRef.current = normalizedInitialLayout.snapshot
      useAppStore.getState().setTabLayout(tabId, normalizedInitialLayout.snapshot)
    }
    const initialLayoutHadBuffers = Boolean(initialLayoutRef.current.buffersByLeafId)
    const hydratedInitialScrollback = hydrateTerminalScrollbackRefs(initialLayoutRef.current)
    if (hydratedInitialScrollback.hydrated) {
      initialLayoutRef.current = hydratedInitialScrollback.layout
    }
    let shouldPersistLayout = false
    const startupWithSetupSplitWait =
      startup && setupSplit
        ? { ...startup, waitForSetupSplitDirection: setupSplit.direction }
        : startup
    const ptyDeps = {
      tabId,
      worktreeId,
      cwd: startupCwd,
      startup: startupWithSetupSplitWait,
      paneTransportsRef,
      paneMode2031Ref,
      paneKittyKeyboardModesRef,
      paneLastThemeModeRef,
      replayingPanesRef,
      restoredViewportBlankingPanesRef,
      isActiveRef,
      isVisibleRef,
      onPtyExitRef,
      onAgentExitedRef,
      onPtyErrorRef,
      onPtyRecoveryStateRef,
      clearTabPtyId,
      consumeSuppressedPtyExit,
      isPtyShutdownPending,
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
      onShowSessionRestoredBanner,
      dispatchNotification,
      setCacheTimerStartedAt,
      syncPanePtyLayoutBinding,
      clearExitedPanePtyLayoutBinding,
      // Why: record the main-answered 2031 subscribe in the CSI handler's registries, else theme flips never push CSI 997.
      recordPaneMode2031Subscription: (paneId: number, repliedMode: 'dark' | 'light') => {
        paneMode2031Ref.current.set(paneId, true)
        paneLastThemeModeRef.current.set(paneId, repliedMode)
      },
      restoredPtyIdByLeafId: initialLayoutRef.current.ptyIdsByLeafId ?? {}
    }

    const unregisterRuntimeTab = registerRuntimeTerminalTab({
      tabId,
      worktreeId,
      getManager: () => managerRef.current,
      getContainer: () => containerRef.current,
      getPtyIdForPane: (paneId) => paneTransportsRef.current.get(paneId)?.getPtyId() ?? null
    })

    const fileOpenLinkHint = getTerminalFileOpenHint()
    const urlOpenLinkHint = getTerminalUrlOpenHint()
    const osc7UncHost = extractUncHost(startupCwd)

    let releaseWebviewDragPassthrough: (() => void) | null = null

    const manager = new PaneManager(container, {
      // `spawnHints.cwd` (from Split actions) lets the new PTY inherit the source pane's cwd — see docs/ssh-split-pane-inherit-cwd.md.
      onPaneCreated: (pane, spawnHints) => {
        // Install mode 2031 handlers before PTY attach so the child's initial CSI ?2031h is captured.
        const mode2031Disposables = installMode2031Handlers({
          paneId: pane.id,
          parser: pane.terminal.parser,
          onSubscribe: () => {
            // Why: for hidden-delivery-gate PTYs, main's '2031-subscribe' fact is the sole responder — don't send a second reply.
            const binding = panePtyBindings.get(pane.id) as
              | (IDisposable & { isHiddenDeliveryGateManagedPty?: () => boolean })
              | undefined
            if (binding?.isHiddenDeliveryGateManagedPty?.()) {
              return
            }
            pushMode2031ForPane(pane.id)
          },
          isReplaying: () => isPaneReplaying(replayingPanesRef, pane.id),
          paneMode2031: paneMode2031Ref.current,
          paneLastThemeMode: paneLastThemeModeRef.current
        })
        mode2031DisposablesRef.current.set(pane.id, mode2031Disposables)

        // OSC 52 — TUI-initiated clipboard writes (tmux/nvim/fzf/ssh).
        // Why: read settingsRef at fire time so mid-session gate toggles apply; return true in both paths so xterm doesn't fall through.
        const osc52Disposable = pane.terminal.parser.registerOscHandler(
          52,
          guardParserHandler('osc-52-clipboard', (data) =>
            handleOsc52ClipboardRequest(data, {
              allowClipboardWrite: settingsRef.current?.terminalAllowOsc52Clipboard === true,
              writeClipboardText: window.api.ui.writeClipboardText,
              onBlockedWrite: showOsc52ClipboardBlockedToast
            })
          )
        )
        osc52DisposablesRef.current.set(pane.id, osc52Disposable)

        // OSC 7 — shell-reported cwd; drives split-pane cwd inheritance. Install MUST stay before connectPanePty:
        // cold-restore replays PTY output synchronously from the first read, so a later handler misses the first OSC 7.
        if (!paneCwdRef.current.has(pane.id)) {
          paneCwdRef.current.set(pane.id, {
            cwd: resolvePaneSeedCwd(spawnHints?.cwd, ptyDeps.cwd),
            confirmed: false
          })
        }
        const osc7Disposable = pane.terminal.parser.registerOscHandler(
          7,
          guardParserHandler('osc-7-cwd', (data) => {
            const parsedCwd = parseOsc7(data, { uncHost: osc7UncHost })
            if (parsedCwd) {
              const confirmed = !isPaneReplaying(replayingPanesRef, pane.id)
              paneCwdRef.current.set(pane.id, { cwd: parsedCwd, confirmed })
            }
            return true
          })
        )
        osc7DisposablesRef.current.set(pane.id, osc7Disposable)

        // Why: let host-handled keys bypass xterm's kitty CSI-u encoder — with kittyKeyboard on it preventDefaults Cmd+C and blocks Chromium's native copy. See xterm-bypass-policy.ts.
        let pendingTerminalInterruptKeyup = false
        const pendingTerminalImeCandidateKeyReleases =
          createTerminalImePendingCandidateKeyReleases()
        const isMac = navigator.userAgent.includes('Mac')
        // Why: Android/ChromeOS UAs also contain "Linux"; scope the fcitx candidate-key policy to desktop Linux.
        const isLinux =
          !isMac &&
          navigator.userAgent.includes('Linux') &&
          !/Android|CrOS/.test(navigator.userAgent)
        const linuxImeCandidateState = isLinux
          ? installTerminalImeLinuxCandidateState(pane.terminal.element)
          : null
        const macNativeTextInputSourceTracker = isMac ? getMacNativeTextInputSourceTracker() : null
        const imeCompositionTracker = installTerminalImeCompositionTracker(pane.terminal.element)
        imeCompositionDisposablesRef.current.set(pane.id, {
          dispose: () => {
            imeCompositionTracker.dispose()
            linuxImeCandidateState?.dispose()
          }
        })
        // Why: only known macOS native text paths (physical CJK/Vietnamese IME) need the keydown bypass; synthetic Unicode lacks physical key identity.
        const imeNativeTextForwarder = isMac
          ? installTerminalImeNativeTextForwarder({
              terminalElement: pane.terminal.element,
              isComposing: () => imeCompositionTracker.isActive(),
              sendInput: (data) => pane.terminal.input(data),
              getInputSourceFeatures: () =>
                macNativeTextInputSourceTracker?.getFeatures() ??
                DISABLED_MAC_NATIVE_TEXT_INPUT_SOURCE_FEATURES
            })
          : {
              claimKeyEvent: () => false,
              dispose: () => undefined
            }
        imeNativeTextForwarderDisposablesRef.current.set(pane.id, imeNativeTextForwarder)
        pane.terminal.attachCustomKeyEventHandler((e) => {
          const linuxCandidateClassification = linuxImeCandidateState?.classifyKeyboardEvent(e) ?? {
            candidateDigitGuardActive: false
          }
          /** Advances the fallback state after every terminal key event path. */
          const observeLinuxCandidateEvent = (): void => {
            linuxImeCandidateState?.observeKeyboardEvent(e, linuxCandidateClassification)
          }
          const now = Date.now()
          const pendingCandidateReleaseGuardActive =
            shouldApplyTerminalImePendingCandidateKeyRelease(
              e,
              pendingTerminalImeCandidateKeyReleases,
              now
            )
          const imeKeyboardOptions = {
            compositionActive: imeCompositionTracker.isActive(),
            candidateKeyGuardActive:
              imeCompositionTracker.isCandidateKeyGuardActive() ||
              pendingCandidateReleaseGuardActive,
            pendingCandidateKeyReleaseActive: pendingCandidateReleaseGuardActive,
            linuxOrphanCandidateDigitGuardActive:
              linuxCandidateClassification.candidateDigitGuardActive,
            isMac,
            isLinux
          }
          if (shouldSuppressTerminalImeKeyboardEvent(e, imeKeyboardOptions)) {
            // Why: clear before arm so a fresh keydown drops any stale pending release before arming its own.
            clearTerminalImePendingCandidateKeyRelease(pendingTerminalImeCandidateKeyReleases, e)
            if (shouldPreventDefaultTerminalImeCandidateKey(e, imeKeyboardOptions)) {
              // Why: without preventDefault the suppressed candidate keydown still fires a keypress and mutates the helper textarea.
              e.preventDefault()
              armTerminalImePendingCandidateKeyRelease(
                pendingTerminalImeCandidateKeyReleases,
                e,
                now
              )
            }
            observeLinuxCandidateEvent()
            return false
          }
          clearTerminalImePendingCandidateKeyRelease(pendingTerminalImeCandidateKeyReleases, e)
          if (pendingTerminalInterruptKeyup && shouldSuppressTerminalInterruptKeyup(e)) {
            pendingTerminalInterruptKeyup = false
            observeLinuxCandidateEvent()
            return false
          }
          if (
            shouldHandleTerminalInterruptKeyboardEvent(e, {
              isMac,
              hasSelection: pane.terminal.hasSelection()
            })
          ) {
            if (e.type === 'keydown') {
              // Why: xterm's kitty encoder can turn plain Ctrl+C into CSI-u; keep ETX transport-agnostic via the onData path.
              pendingTerminalInterruptKeyup = true
              pane.terminal.input(TERMINAL_INTERRUPT_INPUT)
              // Why: CLIs like Codex can die on SIGINT before restoring xterm's Kitty flags, leaving the shell corrupted.
              resetTerminalKeyboardProtocolAfterInterrupt(pane.terminal)
            } else {
              pendingTerminalInterruptKeyup = false
            }
            observeLinuxCandidateEvent()
            return false
          }
          if (shouldSuppressTerminalModifierKeyboardEvent(e)) {
            // Why: stale Kitty keyboard reporting can encode standalone modifier presses before Ctrl+C reaches the interrupt handler.
            observeLinuxCandidateEvent()
            return false
          }

          const jisYenInput = resolveTerminalJisYenInput(e, {
            enabled: settingsRef.current?.terminalJISYenToBackslash === true,
            isMac
          })
          if (jisYenInput) {
            if (jisYenInput.type === 'input') {
              // Why: translated character, not a shortcut — keep it on xterm's onData path so PTY input guards still run.
              pane.terminal.input(jisYenInput.data)
            }
            observeLinuxCandidateEvent()
            return false
          }

          if (e.type === 'keydown') {
            const shouldSyncCurrentTerminal = (): boolean =>
              managerRef.current
                ?.getPanes()
                .some((candidate) => candidate.terminal === pane.terminal) === true
            if (e.key === 'PageUp' || e.key === 'Home') {
              markTerminalPinnedViewport(pane.terminal)
              syncTerminalScrollIntentSoon(pane.terminal, {
                preservePinnedAtBottom: true,
                shouldSync: shouldSyncCurrentTerminal
              })
            } else if (e.key === 'PageDown' || e.key === 'End') {
              syncTerminalScrollIntentSoon(pane.terminal, {
                shouldSync: shouldSyncCurrentTerminal
              })
            }
          }

          if (imeNativeTextForwarder.claimKeyEvent(e)) {
            // Why: bypass xterm's kitty encoder for native text keydowns so the committed glyph survives via the input event.
            observeLinuxCandidateEvent()
            return false
          }

          const shouldBypass = shouldBypassXtermKeyboardEvent(e, {
            isMac,
            hasSelection: pane.terminal.hasSelection()
          })
          observeLinuxCandidateEvent()
          return !shouldBypass
        })

        const linkProviderDisposable = pane.terminal.registerLinkProvider(
          createFilePathLinkProvider(pane.id, linkDeps, pane.linkTooltip, fileOpenLinkHint)
        )
        linkProviderDisposablesRef.current.set(pane.id, linkProviderDisposable)
        const terminalHandleLinkDisposable = pane.terminal.registerLinkProvider(
          createTerminalHandleLinkProvider({
            getTerminal: () =>
              managerRef.current?.getPanes().find((candidate) => candidate.id === pane.id)
                ?.terminal ?? null,
            getRuntimeEnvironmentId: () =>
              linkDeps.getRuntimeEnvironmentIdForPane?.(pane.id) ?? null,
            linkTooltip: pane.linkTooltip
          })
        )
        terminalHandleLinkDisposablesRef.current.set(pane.id, terminalHandleLinkDisposable)
        const fileLinkClickFallbackDisposable = installFilePathLinkClickFallback(
          pane.id,
          pane.terminal,
          linkDeps
        )
        fileLinkClickFallbackDisposablesRef.current.set(pane.id, fileLinkClickFallbackDisposable)
        const httpLinkClickFallbackDisposable = installHttpLinkClickFallback(pane.terminal, {
          ...linkDeps,
          requestOpenLinksInAppPreference
        })
        httpLinkClickFallbackDisposables.set(pane.id, httpLinkClickFallbackDisposable)
        seedStartupSessionRestoredBanner(ptyDeps.startup, pane.id, onShowSessionRestoredBanner)
        // Why: skip empty selections so click-to-deselect doesn't clobber whatever the user last copied.
        const selectionDisposable = pane.terminal.onSelectionChange(() => {
          const shouldWritePrimarySelection = isPrimarySelectionEnabled()
          const shouldWriteClipboard = settingsRef.current?.terminalClipboardOnSelect === true
          if (!shouldWritePrimarySelection && !shouldWriteClipboard) {
            return
          }
          if (!pane.terminal.hasSelection()) {
            return
          }
          if (
            shouldWritePrimarySelection &&
            !shouldWriteClipboard &&
            terminalSelectionExceedsPrimaryLimit(pane.terminal)
          ) {
            return
          }

          if (shouldWritePrimarySelection) {
            const existingTimer = selectionCaptureTimersRef.current.get(pane.id)
            if (existingTimer !== undefined) {
              window.clearTimeout(existingTimer)
            }
            // Why: xterm fires selection changes while dragging; defer the primary-selection write to avoid clipboard churn.
            const timer = window.setTimeout(() => {
              selectionCaptureTimersRef.current.delete(pane.id)
              if (!isPrimarySelectionEnabled() || !pane.terminal.hasSelection()) {
                return
              }
              if (terminalSelectionExceedsPrimaryLimit(pane.terminal)) {
                return
              }
              const selection = pane.terminal.getSelection()
              if (selection) {
                setPrimarySelectionText(selection)
              }
            }, 100)
            selectionCaptureTimersRef.current.set(pane.id, timer)
          }

          if (!shouldWriteClipboard) {
            return
          }
          const selection = pane.terminal.getSelection()
          if (!selection) {
            return
          }
          void window.api.ui.writeClipboardText(selection).catch(() => {
            /* ignore clipboard write failures */
          })
        })
        selectionDisposablesRef.current.set(pane.id, selectionDisposable)
        // Hide mouse cursor while typing (scoped to the pane container so other UI keeps its cursor).
        if (settingsRef.current?.terminalMouseHideWhileTyping) {
          const mouseHideDisposable = installMouseHideWhileTyping(pane.terminal, pane.container)
          mouseHideDisposablesRef.current.set(pane.id, mouseHideDisposable)
        }
        // Why: async tooltip formatting can resolve after the hover changes; a stale result must not overwrite a newer hover/leave.
        let oscTooltipHoverToken = 0
        pane.terminal.options.linkHandler = {
          allowNonHttpProtocols: true,
          activate: (event, text) => {
            const handled = handleOscLink(text, event as MouseEvent | undefined, {
              ...linkDeps,
              startupCwd: getPaneLinkCwd(pane.id),
              runtimeEnvironmentId: linkDeps.getRuntimeEnvironmentIdForPane?.(pane.id) ?? null,
              requestOpenLinksInAppPreference
            })
            // Why: link activation can steal focus before the click's mouseup reaches xterm, stranding its drag-select
            // listener (runaway selection until next click/Esc); clearSelection detaches it (SelectionService._removeMouseDownListeners).
            if (handled) {
              pane.terminal.clearSelection()
            }
          },
          // Show hover tooltip for OSC 8 hyperlinks — same behaviour WebLinksAddon gives plain-text URLs.
          hover: (_event, text) => {
            oscTooltipHoverToken += 1
            const hoverToken = oscTooltipHoverToken
            pane.linkTooltip.textContent = `${text} (${urlOpenLinkHint})`
            pane.linkTooltip.style.display = ''
            void formatTerminalUrlTooltip(text, urlOpenLinkHint).then((nextText) => {
              if (hoverToken === oscTooltipHoverToken && nextText) {
                pane.linkTooltip.textContent = nextText
              }
            })
          },
          leave: () => {
            oscTooltipHoverToken += 1
            pane.linkTooltip.style.display = 'none'
          }
        }
        applyAppearance(manager)
        const panePtyBinding = connectPanePty(pane, manager, {
          ...ptyDeps,
          // Why: spread order matters — spawnHints.cwd (source pane) must override ptyDeps.cwd (worktree root) so splits boot in the live cwd.
          ...(spawnHints?.cwd ? { cwd: spawnHints.cwd } : {}),
          restoredPtyIdByLeafId: spawnHints?.ptyId
            ? {
                ...ptyDeps.restoredPtyIdByLeafId,
                [pane.leafId]: spawnHints.ptyId
              }
            : ptyDeps.restoredPtyIdByLeafId,
          restoredLeafId: pane.leafId
        })
        // Why: connectPanePty clears only its spread copy; clear outer ptyDeps.startup so the initial prompt runs once and later user splits don't replay it.
        ptyDeps.startup = null
        const nextInitialCwdState = clearQueuedInitialCwdAfterFirstPane(
          queuedInitialCwdRef.current,
          defaultTabCwd,
          ptyDeps.cwd
        )
        queuedInitialCwdRef.current = nextInitialCwdState.queuedInitialCwd
        ptyDeps.cwd = nextInitialCwdState.ptyCwd
        panePtyBindings.set(pane.id, panePtyBinding)
        syncPaneCount()
        scheduleRuntimeGraphSync()
        queueResizeAll(true)
      },
      onPaneClosed: (paneId, closedPane) => {
        onPtyRecoveryStateRef?.current?.(paneId, null)
        const isDetachedToTab = closedPane?.reason === 'detach'
        const linkProviderDisposable = linkProviderDisposablesRef.current.get(paneId)
        if (linkProviderDisposable) {
          linkProviderDisposable.dispose()
          linkProviderDisposablesRef.current.delete(paneId)
        }
        const terminalHandleLinkDisposable = terminalHandleLinkDisposablesRef.current.get(paneId)
        if (terminalHandleLinkDisposable) {
          terminalHandleLinkDisposable.dispose()
          terminalHandleLinkDisposablesRef.current.delete(paneId)
        }
        const fileLinkClickFallbackDisposable =
          fileLinkClickFallbackDisposablesRef.current.get(paneId)
        if (fileLinkClickFallbackDisposable) {
          fileLinkClickFallbackDisposable.dispose()
          fileLinkClickFallbackDisposablesRef.current.delete(paneId)
        }
        const httpLinkClickFallbackDisposable = httpLinkClickFallbackDisposables.get(paneId)
        if (httpLinkClickFallbackDisposable) {
          httpLinkClickFallbackDisposable.dispose()
          httpLinkClickFallbackDisposables.delete(paneId)
        }
        const selectionDisposable = selectionDisposablesRef.current.get(paneId)
        if (selectionDisposable) {
          selectionDisposable.dispose()
          selectionDisposablesRef.current.delete(paneId)
        }
        const imeCompositionDisposable = imeCompositionDisposablesRef.current.get(paneId)
        if (imeCompositionDisposable) {
          imeCompositionDisposable.dispose()
          imeCompositionDisposablesRef.current.delete(paneId)
        }
        const imeNativeTextForwarderDisposable =
          imeNativeTextForwarderDisposablesRef.current.get(paneId)
        if (imeNativeTextForwarderDisposable) {
          imeNativeTextForwarderDisposable.dispose()
          imeNativeTextForwarderDisposablesRef.current.delete(paneId)
        }
        const selectionCaptureTimer = selectionCaptureTimersRef.current.get(paneId)
        if (selectionCaptureTimer !== undefined) {
          window.clearTimeout(selectionCaptureTimer)
          selectionCaptureTimersRef.current.delete(paneId)
        }
        const mode2031Disposables = mode2031DisposablesRef.current.get(paneId)
        if (mode2031Disposables) {
          for (const d of mode2031Disposables) {
            d.dispose()
          }
          mode2031DisposablesRef.current.delete(paneId)
        }
        paneMode2031Ref.current.delete(paneId)
        mode2031SeedAttemptTokensRef.current.delete(paneId)
        paneKittyKeyboardModesRef.current.delete(paneId)
        paneLastThemeModeRef.current.delete(paneId)
        const osc52Disposable = osc52DisposablesRef.current.get(paneId)
        if (osc52Disposable) {
          osc52Disposable.dispose()
          osc52DisposablesRef.current.delete(paneId)
        }
        const osc7Disposable = osc7DisposablesRef.current.get(paneId)
        if (osc7Disposable) {
          osc7Disposable.dispose()
          osc7DisposablesRef.current.delete(paneId)
        }
        // Why: drop the tracked cwd so the map doesn't accumulate dead entries over long sessions.
        paneCwdRef.current.delete(paneId)
        const mouseHideDisposable = mouseHideDisposablesRef.current.get(paneId)
        if (mouseHideDisposable) {
          mouseHideDisposable.dispose()
          mouseHideDisposablesRef.current.delete(paneId)
        }
        const transport = paneTransportsRef.current.get(paneId)
        const closedPtyId = transport?.getPtyId() ?? null
        const terminalTab = useAppStore
          .getState()
          .tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
        if (!isDetachedToTab && shouldClearLaunchAgentForClosedPane(terminalTab, closedPtyId)) {
          useAppStore.getState().clearTabLaunchAgent(tabId)
        }
        const panePtyBinding = panePtyBindings.get(paneId)
        if (panePtyBinding) {
          panePtyBinding.dispose()
          panePtyBindings.delete(paneId)
        }
        const leafId = closedPane?.leafId
        if (leafId && !isDetachedToTab) {
          // Why: revoke only this pane's authority; an exact tombstone blocks queued hooks without suppressing siblings.
          const paneKey = makePaneKey(tabId, leafId)
          useAppStore.getState().retireAgentPaneAuthority(paneKey)
        }
        if (transport) {
          if (isDetachedToTab) {
            // Why: detach hands the PTY to a new tab, so drop renderer listeners without a process teardown.
            transport.detach?.()
          } else {
            const ptyId = suppressIntentionalPaneCloseExit(
              transport,
              useAppStore.getState().suppressPtyExit
            )
            if (ptyId) {
              // Why: PaneManager already promoted the sibling; suppress this exit so the survivor isn't mistaken for an exited tab.
              syncPanePtyLayoutBinding(paneId, null)
              clearTabPtyId(tabId, ptyId)
            }
            transport.destroy?.()
          }
          paneTransportsRef.current.delete(paneId)
        }
        clearRuntimePaneTitle(tabId, paneId)
        paneFontSizesRef.current.delete(paneId)
        replayingPanesRef.current.delete(paneId)
        restoredViewportBlankingPanesRef.current.delete(paneId)
        // Clean up pane title state so closed panes don't leave stale entries.
        setPaneTitles((prev) => {
          if (!(paneId in prev)) {
            return prev
          }
          const next = { ...prev }
          delete next[paneId]
          return next
        })
        // Eagerly update the ref so persistLayoutSnapshot (fires right after onPaneClosed) reads correct titles before React's async flush.
        if (paneId in paneTitlesRef.current) {
          const next = { ...paneTitlesRef.current }
          delete next[paneId]
          paneTitlesRef.current = next
        }
        // Dismiss the rename dialog if open for the closed pane, else it submits against a non-existent pane.
        setRenamingPaneId((prev) => (prev === paneId ? null : prev))
        syncPaneCount()
        // Why: closePane() reassigns activePaneId without firing onActivePaneChange, so sync the tab title to the survivor here.
        const newActivePane = managerRef.current?.getActivePane()
        if (newActivePane) {
          reportActiveRendererPtyForPane(paneTransportsRef.current, newActivePane.id)
          const paneTitles = useAppStore.getState().runtimePaneTitlesByTabId[tabId] ?? {}
          updateTabTitle(tabId, resolveTabTitleAfterPaneClose(paneTitles, newActivePane.id))
        }
        scheduleRuntimeGraphSync()
      },
      onActivePaneChange: (pane) => {
        const layout = useAppStore.getState().terminalLayoutsByTabId[tabId]
        const ptyIdsByLeafId = layout?.ptyIdsByLeafId ?? {}
        if (Object.keys(ptyIdsByLeafId).length > 0 && !ptyIdsByLeafId[pane.leafId]) {
          const fallbackLeafId = resolveTerminalLayoutActiveLeafId({
            root: layout?.root,
            activeLeafId: pane.leafId,
            ptyIdsByLeafId
          })
          const fallbackPaneId = fallbackLeafId
            ? (managerRef.current?.getNumericIdForLeaf(fallbackLeafId) ?? null)
            : null
          if (fallbackPaneId != null && fallbackPaneId !== pane.id) {
            // Why: a pane whose PTY exited can stay visible; don't let a click park focus on a leaf that swallows keyboard input.
            managerRef.current?.setActivePane(fallbackPaneId, { focus: true })
            return
          }
        }
        scheduleRuntimeGraphSync()
        // Why: active pane lives in PaneManager; React consumers (e.g. header chat toggle) need a render tick when focus moves between splits.
        syncPaneLayoutRevision()
        if (shouldPersistLayout) {
          persistLayoutSnapshot()
        }
        reportActiveRendererPtyForPane(paneTransportsRef.current, pane.id)
        // Why: the tab icon resolves from the active leaf's process; re-sample a shell-marked pane whose agent still runs, since no OSC boundary will.
        const focusedBinding = panePtyBindings.get(pane.id) as
          | (IDisposable & { sampleForegroundAgentOnFocus?: () => void })
          | undefined
        focusedBinding?.sampleForegroundAgentOnFocus?.()
        // Why: on focus switch between splits, set the tab title to the newly active pane's last-known title so it doesn't show a stale one.
        const paneTitles = useAppStore.getState().runtimePaneTitlesByTabId[tabId] ?? {}
        const paneTitle = paneTitles[pane.id]
        if (paneTitle) {
          updateTabTitle(tabId, paneTitle)
        }
      },
      onLayoutChanged: () => {
        scheduleRuntimeGraphSync()
        syncExpandedLayout()
        syncCanExpandState()
        syncPaneCount()
        syncPaneLayoutRevision()
        queueResizeAll(false)
        if (shouldPersistLayout) {
          persistLayoutSnapshot()
        }
      },
      onPaneDragActiveChange: (active) => {
        if (active) {
          releaseWebviewDragPassthrough?.()
          releaseWebviewDragPassthrough = acquireWebviewsDragPassthrough()
          return
        }
        releaseWebviewDragPassthrough?.()
        releaseWebviewDragPassthrough = null
      },
      resolveExternalPaneDropTarget,
      onExternalPaneDrop,
      terminalOptions: () => {
        const currentSettings = settingsRef.current
        const terminalFontWeights = resolveTerminalFontWeights(currentSettings?.terminalFontWeight)
        const cursorStyle = currentSettings?.terminalCursorStyle ?? 'block'
        const storeState = useAppStore.getState()
        const currentTab = storeState.tabsByWorktree[worktreeId]?.find(
          (candidate) => candidate.id === tabId
        )
        const platformInfo = window.api.platform?.get?.()
        // Why: launch identity is per-pane; a tab-wide hint would leak Grok's KKP exception to shell splits.
        const knownTuiAgent = resolvePaneKeyboardProtocolAgent(
          ptyDeps.startup,
          currentTab?.launchAgent
        )
        const ptyBackendContext = {
          userAgent: navigator.userAgent,
          osRelease: platformInfo?.osRelease,
          connectionId: getConnectionId(worktreeId),
          cwd: startupCwd,
          shellOverride: currentTab?.shellOverride,
          executionHostId: getExecutionHostIdForWorktree(storeState, worktreeId),
          tuiAgent: knownTuiAgent
        }
        const windowsPtyCompatibilityOptions =
          buildWindowsPtyCompatibilityOptions(ptyBackendContext)
        // Why: local Windows ConPTY reads the Kitty advertisement but can't decode CSI-u, so withhold it to restore Enter/Up/Down nav (issue #2434); Grok keeps it.
        const keyboardProtocolOptions = buildTerminalKeyboardProtocolOptions(ptyBackendContext)
        return {
          ...windowsPtyCompatibilityOptions,
          ...keyboardProtocolOptions,
          fontSize: currentSettings?.terminalFontSize ?? 14,
          fontFamily: buildFontFamily(currentSettings?.terminalFontFamily ?? ''),
          fontWeight: terminalFontWeights.fontWeight,
          fontWeightBold: terminalFontWeights.fontWeightBold,
          scrollback: normalizeDesktopTerminalScrollbackRows(
            currentSettings?.terminalScrollbackRows
          ),
          cursorStyle,
          cursorInactiveStyle: resolveTerminalCursorInactiveStyle(cursorStyle),
          cursorBlink: currentSettings?.terminalCursorBlink ?? true,
          scrollSensitivity: normalizeTerminalScrollSensitivity(
            currentSettings?.terminalScrollSensitivity
          ),
          fastScrollSensitivity: normalizeTerminalFastScrollSensitivity(
            currentSettings?.terminalFastScrollSensitivity
          ),
          macOptionIsMeta: effectiveMacOptionAsAltRef.current === 'true',
          lineHeight: normalizeTerminalLineHeight(currentSettings?.terminalLineHeight),
          wordSeparator: currentSettings?.terminalWordSeparator
        }
      },
      terminalTuiScrollSensitivity: () =>
        normalizeTerminalTuiMouseWheelMultiplier(settingsRef.current?.terminalTuiScrollSensitivity),
      onLinkClick: (event, url) => {
        const activePane = managerRef.current?.getActivePane()
        handleTerminalWebLinkClick(url, event, {
          ...linkDeps,
          terminal: activePane?.terminal ?? null,
          startupCwd: activePane ? getPaneLinkCwd(activePane.id) : startupCwd,
          runtimeEnvironmentId: activePane
            ? (linkDeps.getRuntimeEnvironmentIdForPane?.(activePane.id) ?? null)
            : null,
          requestOpenLinksInAppPreference
        })
      },
      formatLinkTooltip: (url, openLinkHint) => formatTerminalUrlTooltip(url, openLinkHint),
      // Why: hidden panes stay mounted so PTYs survive navigation, but their WebGL contexts drain Chromium's budget and can blank visible panes.
      initialRenderingSuspended: !isVisibleRef.current,
      // Why: remote-runtime panes honor the GPU setting too; late snapshots are handled by post-replay rebuildPaneWebgl in pty-connection.
      terminalGpuAcceleration: settingsRef.current?.terminalGpuAcceleration ?? 'auto',
      debugLabel: `tab:${tabId}/wt:${worktreeId}`
    })

    managerRef.current = manager
    // Why: xterm renders to canvas with no a11y addon; expose the manager so E2E can read the buffer via serializeAddon.serialize().
    if (e2eConfig.exposeStore) {
      window.__paneManagers = window.__paneManagers ?? new Map()
      window.__paneManagers.set(tabId, manager)
    }
    const restoredPaneByLeafId = replayTerminalLayout(manager, initialLayoutRef.current, isActive)

    const restoredBuffers = initialLayoutRef.current.buffersByLeafId
    restoreScrollbackBuffers(
      manager,
      restoredBuffers,
      restoredPaneByLeafId,
      replayingPanesRef,
      restoredViewportBlankingPanesRef
    )
    if (restoredBuffers && initialLayoutRef.current.scrollbackRefsByLeafId) {
      const layoutWithoutRestoredBuffers = { ...initialLayoutRef.current }
      delete layoutWithoutRestoredBuffers.buffersByLeafId
      initialLayoutRef.current = layoutWithoutRestoredBuffers
      if (initialLayoutHadBuffers) {
        // Why: raw replay bytes belong to this mount only; drop legacy hydrated copies from Zustand so session writes stay ref-only.
        useAppStore.getState().setTabLayout(tabId, layoutWithoutRestoredBuffers)
      }
    }

    // Seed pane titles via the same old-leafId → new-paneId mapping used for buffer restore.
    const restoredTitles = mapRestoredPaneTitlesByPaneId(
      initialLayoutRef.current.titlesByLeafId,
      restoredPaneByLeafId
    )
    if (Object.keys(restoredTitles).length > 0) {
      // Why: merge (not replace) so we don't discard concurrent onPaneClosed updates React may have batched.
      setPaneTitles((prev) => ({ ...prev, ...restoredTitles }))
      // Why: persist runs right after restore, before React state flushes; sync the ref now so persist keeps restored titles.
      paneTitlesRef.current = { ...paneTitlesRef.current, ...restoredTitles }
    }

    const restoredActivePaneId =
      (initialLayoutRef.current.activeLeafId
        ? restoredPaneByLeafId.get(initialLayoutRef.current.activeLeafId)
        : null) ??
      manager.getActivePane()?.id ??
      manager.getPanes()[0]?.id ??
      null
    if (restoredActivePaneId !== null) {
      manager.setActivePane(restoredActivePaneId, { focus: isActive })
    }
    const restoredExpandedPaneId = initialLayoutRef.current.expandedLeafId
      ? (restoredPaneByLeafId.get(initialLayoutRef.current.expandedLeafId) ?? null)
      : null
    if (restoredExpandedPaneId !== null && manager.getPanes().length > 1) {
      setExpandedPane(restoredExpandedPaneId)
      applyExpandedLayoutTo(restoredExpandedPaneId, {
        managerRef,
        containerRef,
        expandedStyleSnapshotRef
      })
    } else {
      setExpandedPane(null)
    }
    // Why: the setup command is injected into ptyDeps.startup then cleared post-split, else a later user split (Cmd+D) would re-run it.
    let issueAutomationAnchorPaneId: number | null = null
    // Why: capture the main shell pane before splits mutate the list; getPanes()[0] is insertion order, not visual order.
    const initialPane = manager.getActivePane() ?? manager.getPanes()[0]

    // Why: setup/issue panes are internal bootstrap flows, not the user-initiated split recorded below.
    if (setupSplit) {
      if (initialPane) {
        const setupPane = splitPaneWithOneShotStartup(
          ptyDeps,
          { command: setupSplit.command, env: setupSplit.env },
          () => manager.splitPane(initialPane.id, setupSplit.direction)
        )
        issueAutomationAnchorPaneId = setupPane?.id ?? null
        // Restore focus to the main pane for keyboard input; the setup pane runs unattended.
        manager.setActivePane(initialPane.id, { focus: isActive })
      }
    }

    // Why: linked-issue automation spawns its own split independent of setup — it's a per-user prompt, not repo bootstrap, so don't impose ordering.
    if (issueCommandSplit) {
      let targetPane = manager.getActivePane() ?? manager.getPanes()[0] ?? null
      if (issueAutomationAnchorPaneId !== null) {
        // Why: anchor-first fallback without the ternary + nullish chain that `tsgo` misreads as always-nullish.
        targetPane =
          manager.getPanes().find((pane) => pane.id === issueAutomationAnchorPaneId) ?? targetPane
      }
      if (targetPane) {
        splitPaneWithOneShotStartup(
          ptyDeps,
          { command: issueCommandSplit.command, env: issueCommandSplit.env },
          () => manager.splitPane(targetPane.id, 'vertical')
        )
        // Why: if setup already claimed the right half, nest issue automation there so the main terminal stays dominant while setup/issue share the secondary column.
        const focusPaneId =
          issueAutomationAnchorPaneId !== null ? (initialPane?.id ?? targetPane.id) : targetPane.id
        manager.setActivePane(focusPaneId, { focus: isActive })
      }
    }

    shouldPersistLayout = true
    syncCanExpandState()
    syncPaneCount()
    applyAppearance(manager)
    queueResizeAll(isActive)
    persistLayoutSnapshot()
    scheduleRuntimeGraphSync()

    // Why: deliver the startup command via the PTY connection path (waits for shell readiness), not terminal.paste() which can lose input before the shell reads stdin.
    function onCliSplitPane(event: Event): void {
      const detail = (event as CustomEvent<SplitTerminalPaneDetail>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      const mgr = managerRef.current
      if (!mgr) {
        return
      }
      if (detail.newLeafId && mgr.getNumericIdForLeaf(detail.newLeafId) !== null) {
        return
      }
      const sourcePaneId = detail.sourceLeafId
        ? (mgr.getNumericIdForLeaf(detail.sourceLeafId) ?? detail.paneRuntimeId)
        : detail.paneRuntimeId
      if (sourcePaneId < 0) {
        return
      }
      const splitOptions = {
        ...(detail.newLeafId ? { leafId: detail.newLeafId } : {}),
        ...(detail.ptyId ? { ptyId: detail.ptyId } : {})
      }
      if (detail.command) {
        const createdPane = splitPaneWithOneShotStartup(ptyDeps, { command: detail.command }, () =>
          mgr.splitPane(sourcePaneId, detail.direction, splitOptions)
        )
        recordRuntimeCreatedTerminalPaneSplit(createdPane, {
          source: detail.telemetrySource ?? 'command',
          direction: detail.direction
        })
      } else {
        const createdPane = mgr.splitPane(sourcePaneId, detail.direction, splitOptions)
        const telemetrySuppressed = createdPane
          ? consumePendingWebRuntimeSplitMirrorTelemetry(detail.sourcePtyId, detail.direction)
          : false
        recordRuntimeCreatedTerminalPaneSplit(createdPane, {
          source: detail.telemetrySource ?? 'command',
          direction: detail.direction,
          telemetrySuppressed
        })
      }
    }
    window.addEventListener(SPLIT_TERMINAL_PANE_EVENT, onCliSplitPane)

    // Why: CLI-driven pane close goes via CustomEvent so PaneManager promotes a sibling; the last pane falls back to closing the tab.
    function onCliClosePane(event: Event): void {
      const detail = (event as CustomEvent<CloseTerminalPaneDetail>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      const mgr = managerRef.current
      if (!mgr) {
        return
      }
      if (mgr.getPanes().length <= 1) {
        // Why: route through closeTerminalTab (not raw closeTab) so a pinned tab hits the confirmation guard — this was the one path that silently dropped pinned tabs.
        closeTerminalTab(tabId)
      } else {
        mgr.closePane(detail.paneRuntimeId)
        scheduleRuntimeGraphSync()
        syncCanExpandState()
        queueResizeAll(isActive)
        persistLayoutSnapshot()
      }
    }
    window.addEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)

    return () => {
      window.removeEventListener(SPLIT_TERMINAL_PANE_EVENT, onCliSplitPane)
      window.removeEventListener(CLOSE_TERMINAL_PANE_EVENT, onCliClosePane)
      const currentWorktreeTabs = useAppStore.getState().tabsByWorktree[worktreeId]
      const tabStillExists = Boolean(
        currentWorktreeTabs?.some((candidate) => candidate.id === tabId)
      )
      unregisterRuntimeTab()
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf)
      }
      restoreExpandedLayoutFrom(expandedStyleSnapshots)
      for (const disposable of linkDisposables.values()) {
        disposable.dispose()
      }
      linkDisposables.clear()
      for (const disposable of terminalHandleLinkDisposables.values()) {
        disposable.dispose()
      }
      terminalHandleLinkDisposables.clear()
      for (const disposable of fileLinkClickFallbackDisposables.values()) {
        disposable.dispose()
      }
      fileLinkClickFallbackDisposables.clear()
      for (const disposable of httpLinkClickFallbackDisposables.values()) {
        disposable.dispose()
      }
      httpLinkClickFallbackDisposables.clear()
      for (const disposable of selectionDisposables.values()) {
        disposable.dispose()
      }
      selectionDisposables.clear()
      for (const timer of selectionCaptureTimers.values()) {
        window.clearTimeout(timer)
      }
      selectionCaptureTimers.clear()
      for (const disposable of mouseHideDisposables.values()) {
        disposable.dispose()
      }
      mouseHideDisposables.clear()
      for (const disposable of imeCompositionDisposables.values()) {
        disposable.dispose()
      }
      imeCompositionDisposables.clear()
      for (const disposable of imeNativeTextForwarderDisposables.values()) {
        disposable.dispose()
      }
      imeNativeTextForwarderDisposables.clear()
      // Why: hidden-view parking starts pane-less byte watchers right after unmount; record pane identities first so watchers write the same runtime-title slots.
      captureParkedTerminalPaneCandidates(
        tabId,
        worktreeId,
        manager.getPanes().map((capturedPane) => ({
          ptyId: paneTransports.get(capturedPane.id)?.getPtyId() ?? null,
          paneId: capturedPane.id,
          leafId: capturedPane.leafId,
          drivesTabTitle: manager.getActivePane()?.id === capturedPane.id
        }))
      )
      for (const transport of paneTransports.values()) {
        const ptyId = transport.getPtyId()
        if (
          shouldDetachPaneTransportOnUnmount({
            tabStillExists,
            tabId,
            ptyId,
            worktreeTabs: currentWorktreeTabs
          })
        ) {
          // Why: tab-move rehome and web-mirror remount unmount a still-live tab; detach preserves the running PTY so the remount reattaches without restarting the shell.
          transport.detach?.()
        } else {
          // Why: un-attached transports have no PTY ID; destroy so an in-flight spawn resolves to a killed PTY, not a revived stale binding after unmount.
          transport.destroy?.()
        }
      }
      for (const panePtyBinding of panePtyBindings.values()) {
        panePtyBinding.dispose()
      }
      panePtyBindings.clear()
      paneTransports.clear()
      manager.destroy()
      releaseWebviewDragPassthrough?.()
      releaseWebviewDragPassthrough = null
      managerRef.current = null
      if (e2eConfig.exposeStore) {
        // Why: a replacement mount can register before cleanup; preserve the successor so E2E/recovery probes see the live pane.
        if (window.__paneManagers?.get(tabId) === manager) {
          window.__paneManagers.delete(tabId)
        }
      }
      setTabPaneExpanded(tabId, false)
      setTabCanExpandPane(tabId, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, cwd])

  // Why: mobile wake fanout — pane self-selects by worktreeId and fires its own armed --resume while staying hidden (no reveal/focus change).
  useEffect(() => {
    const onWakeHibernatedAgents = (event: Event): void => {
      const detail = (event as CustomEvent<WakeHibernatedAgentsWorktreeDetail>).detail
      if (!detail || detail.worktreeId !== worktreeId) {
        return
      }
      for (const panePtyBinding of panePtyBindingsRef.current.values()) {
        const claimKey = (
          panePtyBinding as IDisposable & {
            wakeHibernatedAgentIfArmed?: (claimedProviderSessions?: Set<string>) => string | null
          }
        ).wakeHibernatedAgentIfArmed?.(detail.wokenClaimKeys)
        // Why: mark woken sessions so the dispatcher's generic resume skips them; the sleeping record clears only after spawn, else the session resumes twice.
        if (claimKey) {
          detail.wokenClaimKeys?.add(claimKey)
        }
      }
    }
    window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWakeHibernatedAgents)
    return () => {
      window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWakeHibernatedAgents)
    }
  }, [worktreeId, panePtyBindingsRef])

  useEffect(() => {
    const previousIsVisible = getPreviousVisibleForTerminalPane({
      previous: previousVisibleForReconcileRef.current,
      tabId,
      cwd
    })
    previousVisibleForReconcileRef.current = { tabId, cwd, isVisible }
    isVisibleRef.current = isVisible
    const resumedFromHidden = isTerminalPaneVisibilityResume({ previousIsVisible, isVisible })
    for (const panePtyBinding of panePtyBindingsRef.current.values()) {
      const bindingWithVisibility = panePtyBinding as IDisposable & {
        syncProcessTracking?: () => void
        noteVisibilityResume?: () => void
      }
      bindingWithVisibility.syncProcessTracking?.()
      // Why: visible-resume repairs dropped hidden resizes but must not fit against xterm's transient hidden DOM fallback.
      if (resumedFromHidden) {
        bindingWithVisibility.noteVisibilityResume?.()
      }
    }
    if (resumedFromHidden && typeof window.api.pty.hasPty === 'function') {
      // Why: a single-PTY liveness check preserves missed-exit recovery without a daemon-wide listSessions.
      reconcileMissingSessions({
        bindings: panePtyBindingsRef.current.values() as Iterable<ReconcilableBinding>,
        hasPty: window.api.pty.hasPty
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable but visibility/identity changes must still refresh PTY process tracking
  }, [cwd, isVisible, isVisibleRef, panePtyBindingsRef, tabId])

  useEffect(() => {
    if (!isActive || !isVisible || typeof window === 'undefined') {
      return
    }
    const onWindowFocus = (): void => {
      const activePane = managerRef.current?.getActivePane()
      if (!activePane) {
        return
      }
      const binding = panePtyBindingsRef.current.get(activePane.id) as
        | (IDisposable & { sampleForegroundAgentOnFocus?: () => void })
        | undefined
      // Why: window refocus doesn't change the active leaf (no onActivePaneChange), so re-sample to revoke stale launch identity before the next Windows Shift+Enter.
      binding?.sampleForegroundAgentOnFocus?.()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [isActive, isVisible, managerRef, panePtyBindingsRef])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager || !settings) {
      return
    }
    applyAppearance(manager)
    // Why: effectiveMacOptionAsAlt can change mid-session (layout switch or override flip); re-apply macOptionIsMeta live on every pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, systemPrefersDark, effectiveMacOptionAsAlt])

  useEffect(() => {
    managerRef.current?.setTerminalGpuAcceleration(settings?.terminalGpuAcceleration ?? 'auto')
  }, [settings?.terminalGpuAcceleration, managerRef])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    // Why: live row-retention changes are xterm option updates only — must not recreate/replay/refit/resize/signal the PTY.
    applyTerminalScrollbackRowsToMountedPanes(manager, terminalScrollbackRows)
  }, [managerRef, terminalScrollbackRows])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const hide = settings?.terminalMouseHideWhileTyping ?? false
    for (const pane of manager.getPanes()) {
      const existing = mouseHideDisposablesRef.current.get(pane.id)
      if (hide && !existing) {
        const disposable = installMouseHideWhileTyping(pane.terminal, pane.container)
        mouseHideDisposablesRef.current.set(pane.id, disposable)
      } else if (!hide && existing) {
        existing.dispose()
        mouseHideDisposablesRef.current.delete(pane.id)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.terminalMouseHideWhileTyping])
}
