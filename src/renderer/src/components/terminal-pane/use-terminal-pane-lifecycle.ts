import { useEffect } from 'react'
import type { IDisposable } from '@xterm/xterm'
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
import type { DirectSshPaneRetryAttemptId } from '@/store/slices/direct-ssh-terminal-recovery'
import type { PaneProcessExit } from './pty-connection-types'
import {
  createFilePathLinkProvider,
  getTerminalFileOpenHint,
  getTerminalUrlOpenHint,
  installFilePathLinkClickFallback
} from './terminal-link-handlers'
import {
  terminalHttpLinkActionDestinationsFor,
  terminalUrlOpenHintOptionsFor
} from './terminal-link-open-hints'
import { createTerminalHandleLinkProvider } from './terminal-handle-links'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import { handleOscLink } from './terminal-osc-link-routing'
import { handleTerminalWebLinkClick } from './terminal-web-link-click'
import {
  installHttpLinkClickFallback,
  type TerminalHttpLinkActionDestinations,
  type TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'
import { installTerminalLinkifierClickPriming } from './terminal-linkifier-click-priming'
import { installTerminalLinkPointerGesture } from './terminal-link-pointer-gesture'
import type {
  TerminalLinkActionContext,
  TerminalLinkActionRequester
} from './terminal-link-action-request'
import {
  resolveLocalhostHttpLinkDisplayUrl,
  type HttpLinkSourceOwner
} from '@/lib/http-link-routing'
import { resolveTerminalHttpLinkSourceOwner } from './terminal-http-link-source-owner'
import { canOpenWorkspaceBrowserTabOnRuntime } from '@/lib/workspace-browser-tab-open'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SetupSplitDirection } from '../../../../shared/worktree/launch-types'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { StartupLaunchTelemetry } from '../../lib/worktree-activation'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import {
  buildFontFamily,
  normalizeTerminalLayoutSnapshot,
  replayTerminalLayout,
  restoreScrollbackBuffers
} from './layout-serialization'
import { RESET_KITTY_KEYBOARD_PROTOCOL } from '../../../../shared/terminal-mode-reset-profiles'
import { resolveTerminalLayoutActiveLeafId } from './terminal-layout-leaf-ids'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { applyExpandedLayoutTo, restoreExpandedLayoutFrom } from './expand-collapse'
import { applyTerminalAppearance } from './terminal-appearance'
import { installMouseHideWhileTyping } from './mouse-hide-while-typing'
import {
  applyTerminalScrollbackRowsToMountedPanes,
  getPreviousVisibleForTerminalPane,
  isTerminalPaneVisibilityResume
} from './terminal-pane-lifecycle-primitives'
import {
  reconcileMissingSessions,
  type ReconcilableBinding
} from './terminal-dead-session-reconcile'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import { useTerminalPaneMountLifecycle } from './use-terminal-pane-mount-lifecycle'
import { useTerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'

export {
  applyTerminalScrollbackRowsToMountedPanes,
  clearQueuedInitialCwdAfterFirstPane,
  createQueuedStartupConsumer,
  getPreviousVisibleForTerminalPane,
  isTerminalPaneVisibilityResume,
  mapRestoredPaneTitlesByPaneId,
  paneOwnsQueuedStartup,
  replayLayoutWithOneShotParkIntent,
  resetTerminalKeyboardProtocolAfterInterrupt,
  resolvePaneLinkCwd,
  resolvePaneSeedCwd,
  resolveQueuedInitialCwd,
  recordRuntimeCreatedTerminalPaneSplit,
  shouldDetachPaneTransportOnUnmount,
  terminalSelectionExceedsPrimaryLimit,
  splitPaneWithOneShotStartup
} from './terminal-pane-lifecycle-primitives'
export {
  applyTerminalPaneCloseRequest,
  retireMountedTerminalPaneSurface,
  suppressIntentionalPaneCloseExit
} from './terminal-pane-lifecycle-close'
export type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'

/** Coordinates mount, visibility, and live appearance effects for terminal panes. */
export function useTerminalPaneLifecycle(deps: UseTerminalPaneLifecycleDeps): void {
  const refs = useTerminalPaneLifecycleRefs()
  useTerminalPaneMountLifecycle(deps, refs)

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

async function formatTerminalUrlTooltip(
  url: string,
  openLinkHint: string,
  sourceOwner: HttpLinkSourceOwner
): Promise<string | null> {
  const labeledUrl = await resolveLocalhostHttpLinkDisplayUrl(url, sourceOwner)
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
    /** Telemetry payload for `agent_started`. Forwarded to `pty:spawn`
     *  so main fires the event only after the spawn succeeds. */
    telemetry?: StartupLaunchTelemetry
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
  requestTerminalLinkAction: TerminalLinkActionRequester
  /** Resolved Option-as-Alt: `'auto'` already mapped to `'true'|'false'` via the layout probe, which lives outside the settings store. */
  effectiveMacOptionAsAlt: EffectiveMacOptionAsAlt
  effectiveMacOptionAsAltRef: React.RefObject<EffectiveMacOptionAsAlt>
  initialLayoutRef: React.RefObject<TerminalLayoutSnapshot>
  managerRef: React.RefObject<PaneManager | null>
  getTabWideAgentHintLeafId: () => string | null
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
  onPaneProcessDied?: (processExit: PaneProcessExit) => void
  onPtyRecoveryStateRef?: React.RefObject<
    (paneId: number, state: PtyTransportRecoveryState | null) => void
  >
  clearTabPtyId: (tabId: string, ptyId: string) => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  isPtyShutdownPending: (ptyId: string) => boolean
  updateTabTitle: (tabId: string, title: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  updateTabPtyId: (
    tabId: string,
    ptyId: string,
    replacedPtyId?: string,
    directSshRetryAttemptId?: DirectSshPaneRetryAttemptId
  ) => void
  markWorktreeUnread: (worktreeId: string) => void
  markTerminalTabUnread: (tabId: string) => void
  markTerminalPaneUnread: (paneKey: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
  onShowSessionRestoredBanner: (paneId: number, reason?: SessionRestoredBannerReason) => void
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

// Why > 1, matching isIOSWebView in mobile/src/terminal/terminal-webview-html.ts: a Mac with a
// touch peripheral can report exactly 1, and it must keep the forwarder. Real iPads report 5.
// Why UA rather than that helper's platform check: an iPhone reports platform "iPhone", not "MacIntel".
export function isTouchIOSUserAgent(userAgent: string, maxTouchPoints: number): boolean {
  return userAgent.includes('Mac') && maxTouchPoints > 1
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

/**
 * Whether this pane's startup is the tab's queued command rather than a payload a split borrowed.
 *
 * Why reference identity and not truthiness: setup/issue splits assign their own one-shot object to
 * the same `deps.startup` field, so "has a startup" would let a split pane spend a command it never
 * runs — and a split's payload can be structurally identical to the queued one (STA-4876).
 */
export function paneOwnsQueuedStartup(
  paneStartup: object | null | undefined,
  queuedStartup: object | null | undefined
): boolean {
  return queuedStartup != null && paneStartup === queuedStartup
}

/**
 * The callback that spends the tab's queued startup command, or `undefined` when this pane does
 * not own it.
 *
 * Why one-shot: `onPtySpawn` fires on every fresh spawn a pane makes — hibernation wake, the
 * respawn ladder — but only the first carried the queued command. A command queued onto the tab
 * afterwards belongs to that later launch, and spending it here would drop it undelivered.
 *
 * Why `isStillQueued` on top of that guard: the replacement can also arrive before this pane's very
 * first spawn, so the slot is only spent while it still holds the command this pane launched.
 */
export function createQueuedStartupConsumer(
  paneStartup: object | null | undefined,
  queuedStartup: object | null | undefined,
  consume: () => void,
  isStillQueued: () => boolean
): (() => void) | undefined {
  if (!paneOwnsQueuedStartup(paneStartup, queuedStartup)) {
    return undefined
  }
  let spent = false
  return () => {
    if (spent) {
      return
    }
    // Why spent regardless: this pane's launch is its one chance at the slot; a later spawn of the
    // same pane must not spend whatever command took its place.
    spent = true
    if (!isStillQueued()) {
      return
    }
    consume()
  }
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

/** Scopes `deps.mountFollowsTerminalPark` to the restored-layout replay. */
export function replayLayoutWithOneShotParkIntent<TRestored>(
  deps: { mountFollowsTerminalPark: boolean },
  replayLayout: () => TRestored
): TRestored {
  // Why: only panes reconstructed by this replay belong to the park reveal; later splits must use ordinary reconnect semantics.
  try {
    return replayLayout()
  } finally {
    deps.mountFollowsTerminalPark = false
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

type TerminalPaneCloseManager = {
  closePane: (paneId: number) => void
  detachPaneForExternalMove: (paneId: number) => boolean
  retirePanePreservingPty: (paneId: number) => boolean
  getNumericIdForLeaf: (leafId: string) => number | null
  getPanes: () => unknown[]
}

export function applyTerminalPaneCloseRequest(args: {
  detail: CloseTerminalPaneDetail
  manager: TerminalPaneCloseManager
  closeTab: () => void
  closeTabPreservingPty: () => void
  getPtyIdForLeaf?: (leafId: string) => string | undefined
}): 'ignored' | 'pane' | 'tab' {
  if (
    args.detail.expectedPtyId &&
    (!args.detail.leafId ||
      args.getPtyIdForLeaf?.(args.detail.leafId) !== args.detail.expectedPtyId)
  ) {
    return 'ignored'
  }
  const paneRuntimeId =
    args.detail.paneRuntimeId ??
    (args.detail.leafId ? args.manager.getNumericIdForLeaf(args.detail.leafId) : null)
  if (paneRuntimeId === null || paneRuntimeId === undefined) {
    return 'ignored'
  }
  if (args.manager.getPanes().length <= 1) {
    if (args.detail.preservePty) {
      args.closeTabPreservingPty()
    } else {
      args.closeTab()
    }
    return 'tab'
  }
  if (args.detail.preservePty) {
    if (args.detail.retireSurface) {
      args.manager.retirePanePreservingPty(paneRuntimeId)
    } else {
      args.manager.detachPaneForExternalMove(paneRuntimeId)
    }
  } else {
    args.manager.closePane(paneRuntimeId)
  }
  return 'pane'
}

export function retireMountedTerminalPaneSurface(args: {
  paneKey: string
  paneId: number
  tabId: string
  ptyId: string | null
  retireAgentPaneAuthority: (
    paneKey: string,
    options?: { preserveSleepingAgentSession?: boolean }
  ) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
  clearTabPtyId: (tabId: string, ptyId: string) => void
  transport?: { detach?: () => void; destroy?: () => void }
}): void {
  args.retireAgentPaneAuthority(args.paneKey, {
    preserveSleepingAgentSession: true
  })
  if (args.ptyId) {
    args.syncPanePtyLayoutBinding(args.paneId, null)
    args.clearTabPtyId(args.tabId, args.ptyId)
  }
  args.transport?.detach?.()
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
  requestTerminalLinkAction,
  effectiveMacOptionAsAlt,
  effectiveMacOptionAsAltRef,
  initialLayoutRef,
  managerRef,
  getTabWideAgentHintLeafId,
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
  onPaneProcessDied,
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
    deps.settings?.terminalScrollbackRows
  )
  const systemPrefersDarkRef = refs.systemPrefersDarkRef
  systemPrefersDarkRef.current = deps.systemPrefersDark

  useEffect(() => {
    const onWakeHibernatedAgents = (event: Event): void => {
      const detail = (event as CustomEvent<{ worktreeId: string; wokenClaimKeys?: Set<string> }>)
        .detail
      if (!detail || detail.worktreeId !== deps.worktreeId) {
        return
      }
      for (const panePtyBinding of deps.panePtyBindingsRef.current.values()) {
        const claimKey = (panePtyBinding as IDisposableWithWake).wakeHibernatedAgentIfArmed?.(
          detail.wokenClaimKeys
        )
        if (claimKey) {
          detail.wokenClaimKeys?.add(claimKey)
        }
      }
    }
    window.addEventListener('orca:wake-hibernated-agents-worktree', onWakeHibernatedAgents)
    return () =>
      window.removeEventListener('orca:wake-hibernated-agents-worktree', onWakeHibernatedAgents)
  }, [deps.worktreeId, deps.panePtyBindingsRef])

  useEffect(() => {
    const previousIsVisible = getPreviousVisibleForTerminalPane({
      previous: refs.previousVisibleForReconcileRef.current,
      tabId: deps.tabId,
      cwd: deps.cwd
    })
    refs.previousVisibleForReconcileRef.current = {
      tabId: deps.tabId,
      cwd: deps.cwd,
      isVisible: deps.isVisible
    }
    deps.isVisibleRef.current = deps.isVisible
    const resumedFromHidden = isTerminalPaneVisibilityResume({
      previousIsVisible,
      isVisible: deps.isVisible
    })
    for (const panePtyBinding of deps.panePtyBindingsRef.current.values()) {
      const binding = panePtyBinding as IDisposableWithVisibility
      binding.syncProcessTracking?.()
      if (resumedFromHidden) {
        binding.noteVisibilityResume?.()
      }
    }
    if (resumedFromHidden && typeof window.api.pty.hasPty === 'function') {
      reconcileMissingSessions({
        bindings: deps.panePtyBindingsRef.current.values() as Iterable<ReconcilableBinding>,
        hasPty: window.api.pty.hasPty
      })
    }
  }, [
    deps.cwd,
    deps.isVisible,
    deps.isVisibleRef,
    deps.panePtyBindingsRef,
    deps.tabId,
    refs.previousVisibleForReconcileRef
  ])

  useEffect(() => {
    if (!deps.isActive || !deps.isVisible || typeof window === 'undefined') {
      return
    }
    const onWindowFocus = (): void => {
      const activePane = deps.managerRef.current?.getActivePane()
      if (!activePane) {
        return
      }
      const binding = deps.panePtyBindingsRef.current.get(activePane.id) as
        | (IDisposable & { sampleForegroundAgentOnFocus?: () => void })
        | undefined
      binding?.sampleForegroundAgentOnFocus?.()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [deps.isActive, deps.isVisible, deps.managerRef, deps.panePtyBindingsRef])

  useEffect(() => {
    const manager = deps.managerRef.current
    const currentSettings = deps.settingsRef.current
    if (!manager || !deps.settings || !currentSettings) {
      return
    }
    applyTerminalAppearance(
      manager,
      currentSettings,
      systemPrefersDarkRef.current,
      deps.paneFontSizesRef.current,
      deps.paneTransportsRef.current,
      deps.effectiveMacOptionAsAltRef.current,
      deps.paneMode2031Ref.current,
      deps.paneLastThemeModeRef.current
    )
  }, [
    deps.settings,
    deps.systemPrefersDark,
    deps.effectiveMacOptionAsAlt,
    deps.managerRef,
    deps.settingsRef,
    deps.paneFontSizesRef,
    deps.paneTransportsRef,
    deps.effectiveMacOptionAsAltRef,
    deps.paneMode2031Ref,
    deps.paneLastThemeModeRef,
    systemPrefersDarkRef
  ])

  useEffect(() => {
    deps.managerRef.current?.setTerminalGpuAcceleration(
      deps.settings?.terminalGpuAcceleration ?? 'auto'
    )
  }, [deps.settings?.terminalGpuAcceleration, deps.managerRef])

  useEffect(() => {
    const manager = deps.managerRef.current
    if (!manager) {
      return
    }
    applyTerminalScrollbackRowsToMountedPanes(manager, terminalScrollbackRows)
  }, [deps.managerRef, terminalScrollbackRows])

  useEffect(() => {
    const manager = deps.managerRef.current
    if (!manager) {
      return
    }
    const hide = deps.settings?.terminalMouseHideWhileTyping ?? false
    for (const pane of manager.getPanes()) {
      const existing = refs.mouseHideDisposablesRef.current.get(pane.id)
      if (hide && !existing) {
        refs.mouseHideDisposablesRef.current.set(
          pane.id,
          installMouseHideWhileTyping(pane.terminal, pane.container)
        )
      } else if (!hide && existing) {
        existing.dispose()
        refs.mouseHideDisposablesRef.current.delete(pane.id)
      }
    }
  }, [deps.settings?.terminalMouseHideWhileTyping, deps.managerRef, refs.mouseHideDisposablesRef])
}

type IDisposableWithWake = IDisposable & {
  wakeHibernatedAgentIfArmed?: (claimedProviderSessions?: Set<string>) => string | null
}

type IDisposableWithVisibility = IDisposable & {
  syncProcessTracking?: () => void
  noteVisibilityResume?: () => void
}
