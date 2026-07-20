/* oxlint-disable max-lines */
import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import type { IBuffer, IDisposable } from '@xterm/xterm'
import { resolveCursorAgentImeAnchor } from '@/lib/pane-manager/terminal-ime-anchor'
import { detectAgentStatusFromTitle, agentTypeToIconAgent, isClaudeAgent } from '@/lib/agent-status'
import { resolvePaneTitleDecision } from './terminal-title-evidence'
import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import { createTerminalZeroDimensionsMessage } from '../../../../shared/terminal-zero-dimensions-diagnostic'
import { parseTerminalOscColorQuery } from '../../../../shared/terminal-osc-color-reply'
import {
  HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS,
  containsCsiRendererQuery,
  containsStatefulRendererQuery,
  extractHiddenStartupRendererQueryData,
  findCsiFinalByteIndex,
  isStatefulRendererReplyCsiQuery,
  isStatelessRendererReplyCsiQuery
} from '../../../../shared/terminal-reply-query-extraction'
import { takeCurrentPtyDeliveryAckCredit } from './terminal-pty-ack-gate'
import { serializeWithAbsoluteCursor } from '../../../../shared/terminal-serialize-absolute-cursor'
import { isTerminalQueryReply } from '../../../../shared/terminal-query-reply'
import type { PtyBufferSnapshot, PtyConnectResult } from './pty-transport'
import { createIpcPtyTransport } from './pty-transport'
import { createRemoteRuntimePtyTransport } from './remote-runtime-pty-transport'
import { getConnectionId } from '@/lib/connection-context'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { shouldSeedCacheTimerOnInitialTitle } from './cache-timer-seeding'
import {
  shouldReconcileDeadSession,
  shouldReconcileMissingSession,
  type HasPty
} from './terminal-dead-session-reconcile'
import type { PtyConnectionDeps } from './pty-connection-types'
import {
  cancelPendingSafeFitContinuations,
  safeFit,
  safeFitAndThen,
  type SafeFitContinuationHandle
} from '@/lib/pane-manager/pane-tree-ops'
import { requestStablePaneFit } from '@/lib/pane-manager/pane-fit-resize-observer'
import { getFitOverrideForPty, bindPanePtyId } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { reconcilePtySizeAcrossFrames, type PtySizeReconcileHandle } from './pty-size-reconcile'
import { shouldClaimRemoteDesktopViewport } from './remote-desktop-viewport-claim'
import { getAppliedSizeReadE2eDelayMs } from './pty-applied-size-read-e2e-delay'
import { createPtySizeReassertion } from './pty-size-reassertion'
import {
  isPaneReplaying,
  replayIntoTerminal,
  replayIntoTerminalAsync,
  waitForTerminalReplayWritesParsed
} from './replay-guard'
import {
  isTerminalWritePipelineCertifiedDead,
  registerUndeliverableWriteHandler
} from '@/lib/pane-manager/terminal-write-pipeline-health'
import {
  captureTerminalPaneRecoveryGeneration,
  registerTerminalPaneRecoveryInstance,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from './stale-document-visibility'
import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'
import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import {
  nativeWindowsRewriteNeedsFollowupRenderRefresh,
  terminalOutputPrefersRenderRefresh,
  terminalRewriteOutputRenderRefreshDecision,
  terminalRewriteOutputPrefersRenderRefresh,
  windowsEastAsianOutputPrefersRenderRefresh
} from '@/lib/pane-manager/terminal-complex-script'
import {
  PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
  queuePanePtyResizeIfHeld,
  type PanePtyResizeHoldFlushDetail
} from '@/lib/pane-manager/pane-pty-resize-hold'
import {
  buildPostReplayLiveAgentReattachReset,
  POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
  POST_REPLAY_LIVE_SNAPSHOT_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_KITTY_KEYBOARD_PROTOCOL,
  RESET_TERMINAL_CURSOR_STYLE
} from './layout-serialization'
import { buildFreshShellViewportBlankingSequence } from './terminal-restored-viewport'
import { createShellReadyMarkerScanState, scanForShellReadyMarker } from './shell-ready-marker-scan'
import { shouldUseShellReadyStartupDelivery } from '../../../../shared/codex-startup-delivery'
import { resolveSetupAgentSequenceLaunchCommand } from '../../../../shared/setup-agent-sequencing'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import {
  mode2031SequenceFor,
  resolveTerminalColorSchemeMode,
  scanMode2031Sequences
} from '../../../../shared/terminal-color-scheme-protocol'
import { warnTerminalLifecycleAnomaly } from './terminal-lifecycle-diagnostics'
import { subscribeToTerminalUserInput } from './terminal-user-input-signal'
import {
  hasPtySerializer,
  registerPtySerializer,
  registerPtyTitleSource
} from './pty-buffer-serializer'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import {
  discardTerminalOutput,
  flushTerminalOutput,
  registerTerminalBacklogRecovery,
  waitForTerminalOutputParsed,
  writeTerminalOutput
} from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { recordAgentHibernationPaneOutput } from '@/lib/agent-hibernation-output-activity'
import {
  isLocalNativeWindowsConpty,
  resolveWindowsShellOverride
} from '@/lib/pane-manager/windows-pty-compatibility'
import { recordTerminalOutput } from '@/lib/pane-manager/pane-scroll'
import { ensureArabicShapingJoinerForText } from '@/lib/pane-manager/terminal-arabic-shaping-joiner'
import { clearTerminalScrollbackAndFollowOutput } from '@/lib/pane-manager/terminal-scrollback-clear'
import {
  enforceTerminalCurrentScrollIntent,
  getTerminalScrollIntentKind,
  markTerminalFollowOutput
} from '@/lib/pane-manager/terminal-scroll-intent'
import {
  cancelTerminalScrollIntentBufferRebuildCompletions,
  deferTerminalGeometryMutationDuringRebuild
} from '@/lib/pane-manager/terminal-scroll-intent-rebuild'
import { createTerminalStructuralReplayCoordinator } from '@/lib/pane-manager/terminal-structural-replay-coordinator'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { makePaneKey, parseLegacyNumericPaneKey } from '../../../../shared/stable-pane-id'
import {
  getProviderSessionClaimKey,
  isPassiveCompletedHibernationEvidence
} from '@/lib/sleeping-agent-pane-ownership'
import { createTerminalCommandLifecycle } from './terminal-command-lifecycle'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { resolveSshPaneConnectGate } from './ssh-pane-connect-gate'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { e2eConfig } from '@/lib/e2e-config'
import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry,
  type AgentType
} from '../../../../shared/agent-status-types'
import { isWebTerminalSurfaceTabId } from '@/runtime/web-terminal-surface-id'
import {
  createAgentInterruptInference,
  isCtrlCKeyEvent,
  isPlainEscapeKeyEvent
} from './agent-interrupt-inference'
import { createAgentQuestionAnsweredInference } from './agent-question-answered-inference'
import {
  AGENT_INTERRUPT_SETTLE_MS,
  type AgentInterruptInputIntent
} from '../../../../shared/agent-interrupt-intent'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  dispatchAgentHookTerminalLifecycle,
  registerAgentHookTerminalLifecycleHandler
} from './agent-hook-terminal-lifecycle'
import {
  createCodexAutoApprovalHookCompletionSuppressor,
  shouldSuppressCodexAutoApprovalSyntheticTitle,
  shouldSuppressCodexAutoApprovalStatus
} from './codex-auto-approval-notification-suppression'
import type {
  AgentCompletionDispatchMeta,
  AgentCompletionStatusSnapshot
} from './agent-completion-coordinator-types'
import {
  markTerminalBracketedPasteInterrupted,
  observeTerminalBracketedPasteModeOutput
} from './terminal-bracketed-paste'
import { executeTerminalStartupCommandPaste } from './terminal-startup-command-paste'
import {
  waitForStableStartupGrid,
  type TerminalStartupGridSettleHandle
} from './terminal-startup-grid-settle'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { isKnownTuiAgentTerminalStartupCommand } from './terminal-startup-command-classifier'
import { createCommandCodeOutputStatusDetector } from '../../../../shared/command-code-output-status'
import type { PtyDataMeta } from './pty-dispatcher'
import { getEagerPtyBufferHandle } from './pty-dispatcher'
import { createTerminalGitHubPRLinkDetector } from '../../../../shared/terminal-github-pr-link-detector'
import { scheduleTerminalWebglAtlasRecovery } from './terminal-webgl-atlas-recovery'
import {
  CONPTY_DA1_RESPONSE,
  DEFAULT_DA1_RESPONSE,
  createTerminalPixelSizeQueryResponder,
  installTerminalCapabilityReplyHandlers,
  sendTerminalOscColorQueryReplies
} from './terminal-capability-replies'
import { registerPtyModelRestoreNeededHandler } from './pty-model-restore-channel'
import {
  acquireHiddenRendererPtyDeliveryClaim,
  declareRendererPtyDeliveryVisible,
  releaseRendererPtyVisibilityClaim,
  setRendererPtyVisibilityClaim
} from './pty-renderer-delivery-claims'
import {
  cancelScheduledHiddenOutputRestore,
  scheduleHiddenOutputRestore
} from './hidden-output-restore-scheduler'
import { resolveHiddenRestoreScrollbackRows } from './terminal-hidden-restore-scrollback'
import {
  getExecutionHostIdForWorktree,
  getSettingsForWorktreeRuntimeOwner,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status-terminal-title'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type ResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from '../../../../shared/agent-title-owner'
import { resolvePaneAgentOwner } from '../../../../shared/pane-agent-owner'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import {
  isExpectedAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../../../../shared/agent-process-recognition'
import type { SetupSplitDirection, TuiAgent } from '../../../../shared/types'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { createDraftPasteReadyScanner } from '../../../../shared/draft-paste-ready-scanner'
import { sendAgentDraftPasteContent } from '@/lib/agent-draft-paste-content'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import {
  beginAgentStartupDeliveryAttempt,
  releaseAgentStartupDeliveryAttempt
} from '@/lib/agent-startup-delayed-delivery'
import {
  AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS,
  AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS,
  canDispatchAgentNotificationAfterGrace,
  isAgentTaskCompleteOsNotificationEnabledFromState,
  isAgentTaskCompleteTrackingEnabledFromState
} from './agent-task-complete-policy'
import {
  isMainTerminalSideEffectAuthorityForPty,
  registerTerminalSideEffectFactConsumer
} from './terminal-side-effect-facts-handler'
import { isRendererHiddenPtyDeliveryGateEnabled } from './terminal-hidden-delivery-gate'

const pendingSpawnByPaneKey = new Map<string, Promise<string | null>>()
const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
const REMOTE_PTY_ID_PREFIX = 'remote:'
const PTY_CONNECT_DIAG_LIMIT = 200
const COMMAND_CODE_OUTPUT_DONE_SETTLE_MS = 1500
const SSH_SHELL_READY_STARTUP_FALLBACK_MS = 1500
const MANUAL_AGENT_COMMAND_MAX_CHARS = 4096
const STARTUP_DRAFT_PASTE_QUIET_MS = 1500
// Why: the notice deliberately omits the rejected path — saved cwds can
// contain private repo/user names; the terminal itself shows where it opened.
export const STARTUP_CWD_FALLBACK_NOTICE =
  '\r\n[Orca opened this terminal at the workspace root because its saved start folder no longer exists.]\r\n'
const STARTUP_DRAFT_PASTE_TIMEOUT_MS = 8000
const HIDDEN_OUTPUT_RESTORE_PENDING_CHARS = 512 * 1024
const HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MS = 50
const HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MAX = 3
const HIDDEN_OUTPUT_RESTORE_FOREGROUND_TIMEOUT_MS = 750
// Why (rc.7.perf DSR-timeout feedback loop): under a foreground flood the
// restore pipeline is its own bottleneck — each synchronous snapshot replay
// starves ACK processing, main pins at the in-flight cap, drops at the
// pending cap, and every drop marker re-armed another restore until the
// flood ended. Backpressure evidence opens this suppression window: drop
// markers inside it must not re-arm restores; live bytes write through and
// ONE deferred repaint (when the window closes) heals the visual gap.
const HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS = 2000
// Backstop for the same loop: a single in-flight restore task may re-iterate
// (fresh-snapshot marks, unmappable slices) only this many times before it
// abandons and lets live bytes flow.
const HIDDEN_OUTPUT_RESTORE_MAX_LOOP_ITERATIONS = 3
const TERMINAL_RENDERER_RISK_SCAN_TAIL_CHARS = 256
const SYNCHRONIZED_OUTPUT_START_SEQUENCE = '\x1b[?2026h'
const SYNCHRONIZED_OUTPUT_END_SEQUENCE = '\x1b[?2026l'
const SYNCHRONIZED_OUTPUT_MARKER_TAIL_CHARS = SYNCHRONIZED_OUTPUT_START_SEQUENCE.length - 1
const CURSOR_SHOW_SEQUENCE = '\x1b[?25h'
const CURSOR_HIDE_SEQUENCE = '\x1b[?25l'
const TERMINAL_FOCUS_IN_SEQUENCE = '\x1b[I'
const TERMINAL_FOCUS_OUT_SEQUENCE = '\x1b[O'
const FOCUS_REPORTING_DISABLE_SEQUENCE = '\x1b[?1004l'
const REATTACH_IDLE_AGENT_CURSOR_RESET_DELAY_MS = 250
const SHIFT_ENTER_RECONFIRM_IDLE_MS = 350
const FOREGROUND_THROUGHPUT_IMMEDIATE_CHARS = 2048
const FOREGROUND_INTERACTIVE_REDRAW_CHARS = 128 * 1024
const FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS = 150
// Why: a submit repaint can take longer than one keystroke echo to fully
// arrive, so a synchronized frame that *began* this close to a keystroke stays
// latency-sensitive even when ConPTY splits its end marker past the redraw
// window — the keystroke is the "user is here, paint now" signal, not the
// late closing chunk.
const FOREGROUND_SYNCHRONIZED_FRAME_INTERACTIVE_WINDOW_MS = 400
// Why: OpenTUI can emit many tiny redraws that each look interactive but
// collectively starve timers unless foreground writes have a rolling budget.
const FOREGROUND_IMMEDIATE_BUDGET_CHARS = 128 * 1024
const FOREGROUND_BUDGET_WINDOW_MS = 500
const INACTIVE_FOREGROUND_IMMEDIATE_BUDGET_CHARS = 32 * 1024
const FOREGROUND_GRID_DRIFT_CHECK_MIN_MS = 250
// Why: this is only shown if hidden renderer output was skipped and main-owned
// terminal state is unavailable, so the user has an explicit loss signal.
const HIDDEN_OUTPUT_RESTORE_UNAVAILABLE_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped hidden terminal output because main recovery was unavailable.]\r\n'
type E2eTerminalPtyDataInjectionApi = {
  inject: (paneKey: string, data: string, meta?: PtyDataMeta) => boolean
  keys: () => string[]
}

type TerminalWithFocusMode = {
  textarea?: HTMLTextAreaElement | null
  modes?: {
    sendFocusMode?: boolean
  }
}

type TerminalWithInspectableBuffer = {
  cols: number
  rows: number
  buffer?: {
    active?: IBuffer
  }
}

// Why: replay bytes can carry a dead run's screen in scrollback — or still
// painted in the viewport with a shell prompt below it — so once xterm has
// parsed the replay the confirmation needs both the cursor-agent screen shape
// AND the parked cursor. A dead screen leaves the shell cursor after its
// prompt; a live agent that needs the focus-in is by definition parked, and a
// live agent that is not parked only loses focus reporting the way the
// pre-fix reattach always did. Returns null when the buffer is not
// inspectable (e.g. test doubles).
function parsedViewportShowsParkedCursorAgentScreen(
  terminal: TerminalWithInspectableBuffer
): boolean | null {
  const buffer = terminal.buffer?.active
  if (
    !buffer ||
    typeof buffer.getLine !== 'function' ||
    typeof buffer.cursorX !== 'number' ||
    typeof buffer.cursorY !== 'number'
  ) {
    return null
  }
  return (
    resolveCursorAgentImeAnchor({
      buffer,
      rows: terminal.rows,
      cols: terminal.cols,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY
    }) !== null
  )
}

function terminalHasFocusReportingEnabled(terminal: TerminalWithFocusMode): boolean {
  return terminal.modes?.sendFocusMode === true
}

function terminalOwnsDomFocus(terminal: TerminalWithFocusMode): boolean {
  if (typeof document === 'undefined' || !terminal.textarea) {
    return false
  }
  return document.activeElement === terminal.textarea
}

function stripAnsiCsiSequences(data: string): string {
  let normalized = ''
  let index = 0
  while (index < data.length) {
    if (data.charCodeAt(index) === 0x1b && data[index + 1] === '[') {
      index += 2
      while (index < data.length) {
        const code = data.charCodeAt(index)
        index += 1
        if (code >= 0x40 && code <= 0x7e) {
          break
        }
      }
      continue
    }
    normalized += data[index]
    index += 1
  }
  return normalized
}

const CURSOR_AGENT_REATTACH_HEADER = 'Cursor Agent'
const CURSOR_AGENT_REATTACH_INPUT_MARKER = '→'
const CURSOR_AGENT_REATTACH_SCREEN_SIGNAL_MAX_CHARS = 5000

function hasCursorAgentReattachPayloadScreenSignal(data: string): boolean {
  const normalized = stripAnsiCsiSequences(data)
  // Why: anchor on the LAST header occurrence — replay buffers keep scrollback,
  // and an earlier finished run must not classify the current screen.
  const headerIndex = normalized.lastIndexOf(CURSOR_AGENT_REATTACH_HEADER)
  if (headerIndex === -1) {
    return false
  }
  const screenTail = normalized.slice(
    headerIndex + CURSOR_AGENT_REATTACH_HEADER.length,
    headerIndex + CURSOR_AGENT_REATTACH_SCREEN_SIGNAL_MAX_CHARS
  )
  return screenTail.includes(`${CURSOR_AGENT_REATTACH_INPUT_MARKER} `)
}

type E2eTerminalPtyDataInjectionWindow = Window & {
  __terminalPtyDataInjection?: E2eTerminalPtyDataInjectionApi
  __terminalHiddenSnapshotOverride?: E2eTerminalHiddenSnapshotOverrideApi
}

const e2eTerminalPtyDataInjectors = new Map<string, (data: string, meta?: PtyDataMeta) => void>()

type E2eTerminalHiddenSnapshotOverrideApi = {
  setPending: (ptyId: string, snapshot: PtyBufferSnapshot) => void
  resolve: (ptyId: string) => void
  clear: (ptyId: string) => void
}

type E2eTerminalHiddenSnapshotOverride = {
  promise: Promise<PtyBufferSnapshot | null>
  resolve: () => void
}

const e2eTerminalHiddenSnapshotOverrides = new Map<string, E2eTerminalHiddenSnapshotOverride>()

// Why: the per-chunk hidden-skip grammar is deleted (Phase 6) — hidden bytes
// either never reach the renderer (delivery gate) or ride the background
// scheduler queue. Only the mode-2031 fact-reply counter still has a producer.
type E2eTerminalPtyOutputDebugSnapshot = {
  hiddenRendererSkipCount: number
  hiddenRendererSkippedChars: number
  hiddenRendererMode2031ReplyCount: number
}

type E2eTerminalPtyOutputDebugApi = {
  reset: () => void
  snapshot: () => E2eTerminalPtyOutputDebugSnapshot
}

type E2eTerminalPtyOutputDebugWindow = Window & {
  __terminalPtyOutputDebug?: E2eTerminalPtyOutputDebugApi
}

type PendingStartupCommand = {
  command: string
  env?: Record<string, string>
}

type FreshSpawnOptions = {
  forceBlankRestoredViewport?: boolean
}

type ColdRestoreAgentResumeStartup = PendingStartupCommand & {
  agent: ResumableTuiAgent
  launchConfig: NonNullable<ReturnType<typeof buildAgentResumeStartupPlan>>['launchConfig']
  launchToken: string
  useLiveEntry: boolean
  hasSleepingRecord: boolean
  sleepingRecordEntry: { paneKey: string; record: SleepingAgentSessionRecord } | null
}

const e2eTerminalPtyOutputDebugState: E2eTerminalPtyOutputDebugSnapshot = {
  hiddenRendererSkipCount: 0,
  hiddenRendererSkippedChars: 0,
  hiddenRendererMode2031ReplyCount: 0
}

function resetE2eTerminalPtyOutputDebug(): void {
  e2eTerminalPtyOutputDebugState.hiddenRendererSkipCount = 0
  e2eTerminalPtyOutputDebugState.hiddenRendererSkippedChars = 0
  e2eTerminalPtyOutputDebugState.hiddenRendererMode2031ReplyCount = 0
}

function exposeE2eTerminalPtyOutputDebug(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  const target = window as E2eTerminalPtyOutputDebugWindow
  target.__terminalPtyOutputDebug ??= {
    reset: resetE2eTerminalPtyOutputDebug,
    snapshot: () => ({ ...e2eTerminalPtyOutputDebugState })
  }
}

function recordHiddenRendererSkip(chars: number): void {
  if (!e2eConfig.exposeStore) {
    return
  }
  exposeE2eTerminalPtyOutputDebug()
  e2eTerminalPtyOutputDebugState.hiddenRendererSkipCount += 1
  e2eTerminalPtyOutputDebugState.hiddenRendererSkippedChars += chars
}

function recordHiddenMode2031Reply(): void {
  if (!e2eConfig.exposeStore) {
    return
  }
  exposeE2eTerminalPtyOutputDebug()
  e2eTerminalPtyOutputDebugState.hiddenRendererMode2031ReplyCount += 1
}

function exposeE2eTerminalPtyDataInjection(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  // Why: a real PTY can coalesce tiny TUI redraws before E2E sees them. This
  // e2e-only seam lets tests replay the renderer-side data callback exactly.
  const target = window as E2eTerminalPtyDataInjectionWindow
  target.__terminalPtyDataInjection ??= {
    inject: (paneKey, data, meta) => {
      const inject = e2eTerminalPtyDataInjectors.get(paneKey)
      if (!inject) {
        return false
      }
      inject(data, meta)
      return true
    },
    keys: () => [...e2eTerminalPtyDataInjectors.keys()]
  }
  target.__terminalHiddenSnapshotOverride ??= {
    setPending: (ptyId, snapshot) => {
      let resolve = (): void => {}
      const wait = new Promise<void>((nextResolve) => {
        resolve = nextResolve
      })
      e2eTerminalHiddenSnapshotOverrides.set(ptyId, {
        promise: wait.then(() => snapshot),
        resolve
      })
    },
    resolve: (ptyId) => {
      e2eTerminalHiddenSnapshotOverrides.get(ptyId)?.resolve()
    },
    clear: (ptyId) => {
      e2eTerminalHiddenSnapshotOverrides.delete(ptyId)
    }
  }
}

function registerE2eTerminalPtyDataInjection(
  paneKey: string,
  inject: (data: string, meta?: PtyDataMeta) => void
): () => void {
  if (!e2eConfig.exposeStore) {
    return () => {}
  }
  exposeE2eTerminalPtyDataInjection()
  e2eTerminalPtyDataInjectors.set(paneKey, inject)
  return () => {
    if (e2eTerminalPtyDataInjectors.get(paneKey) === inject) {
      e2eTerminalPtyDataInjectors.delete(paneKey)
    }
  }
}

function readE2eHiddenSnapshotOverride(ptyId: string): Promise<PtyBufferSnapshot | null> | null {
  if (!e2eConfig.exposeStore) {
    return null
  }
  const override = e2eTerminalHiddenSnapshotOverrides.get(ptyId)
  if (!override) {
    return null
  }
  // Why: visual E2E needs to hold a hidden restore snapshot in flight so a
  // newer live TUI frame can race it deterministically.
  return override.promise.finally(() => {
    if (e2eTerminalHiddenSnapshotOverrides.get(ptyId) === override) {
      e2eTerminalHiddenSnapshotOverrides.delete(ptyId)
    }
  })
}

function shouldKeepHiddenStartupRendererQueriesLive(
  startup: PtyConnectionDeps['startup']
): boolean {
  return (
    Boolean(startup?.telemetry?.agent_kind && startup.telemetry.agent_kind !== 'other') ||
    isKnownTuiAgentTerminalStartupCommand(startup?.command ?? '')
  )
}

function containsHiddenStartupRendererQuery(data: string): boolean {
  // Why: hidden Codex startup must not live-render ordinary redraw floods, but
  // query chunks still need xterm's built-in terminal replies to unblock TUIs.
  return containsCsiRendererQuery(data) || data.includes('\x1b]10;?') || data.includes('\x1b]11;?')
}

let codexRestartNoticePresenceSource: Record<
  string,
  { previousAccountLabel: string; nextAccountLabel: string }
> | null = null
let codexRestartNoticePresence = false
let inactiveForegroundImmediateBudgetChars = 0
let inactiveForegroundImmediateBudgetWindowStart = 0

type PanePtyBinding = IDisposable & {
  syncProcessTracking: () => void
  noteVisibilityResume: () => void
  /** Navigation-free hibernation wake: fires the armed cold-restore --resume
   *  without the size-reassert/foreground-sample side effects of a real reveal.
   *  Used by the mobile wake fanout so a hidden hibernated pane resumes with no
   *  desktop hidden→visible transition. Returns the sleeping record's provider
   *  session claim key when this pane started (or latched) the in-place wake,
   *  so the follow-up generic resume never launches the same session twice. */
  wakeHibernatedAgentIfArmed: (claimedProviderSessions?: Set<string>) => string | null
  /** Re-sample process identity when the pane gains intra-tab focus: the tab
   *  icon follows the active leaf, and a shell-marked entry on a still-running
   *  agent pane has no OSC boundary left to correct it. */
  sampleForegroundAgentOnFocus: () => void
  /** Reconfirm after direct shortcut input, which bypasses PTY onData. */
  requestDroidReconfirmation: () => void
  reconcileIfSessionDead: (liveSessionIds: Set<string>, snapshotRequestedAt?: number) => void
  reconcileIfSessionMissing: (hasPty: HasPty, livenessRequestedAt?: number) => void
  /** True when the hidden-delivery gate structurally manages the pane's
   *  current PTY. The lifecycle's xterm CSI ?2031h observer consults this to
   *  stay silent — main's '2031-subscribe' fact is the sole responder for
   *  gate-managed PTYs. */
  isHiddenDeliveryGateManagedPty: () => boolean
}

function isAgentTaskCompleteNotificationEnabled(): boolean {
  return isAgentTaskCompleteOsNotificationEnabledFromState(useAppStore.getState())
}

function isAgentTaskCompleteTrackingEnabled(): boolean {
  return isAgentTaskCompleteTrackingEnabledFromState(useAppStore.getState())
}

const agentTaskCompleteTrackingEnabledListeners = new Set<() => void>()
let agentTaskCompleteTrackingSettingsUnsubscribe: (() => void) | null = null
let agentTaskCompleteTrackingSettingsSnapshot: string | null = null

function getAgentTaskCompleteTrackingSettingsSnapshot(
  state: ReturnType<typeof useAppStore.getState>
): string {
  return `${isAgentTaskCompleteTrackingEnabledFromState(state)}:${isAgentTaskCompleteOsNotificationEnabledFromState(state)}`
}

function subscribeAgentTaskCompleteTrackingEnabled(listener: () => void): () => void {
  if (agentTaskCompleteTrackingSettingsUnsubscribe === null) {
    agentTaskCompleteTrackingSettingsSnapshot = getAgentTaskCompleteTrackingSettingsSnapshot(
      useAppStore.getState()
    )
    agentTaskCompleteTrackingSettingsUnsubscribe = useAppStore.subscribe((state) => {
      const snapshot = getAgentTaskCompleteTrackingSettingsSnapshot(state)
      if (snapshot === agentTaskCompleteTrackingSettingsSnapshot) {
        return
      }
      agentTaskCompleteTrackingSettingsSnapshot = snapshot
      for (const subscriber of Array.from(agentTaskCompleteTrackingEnabledListeners)) {
        subscriber()
      }
    })
  }

  agentTaskCompleteTrackingEnabledListeners.add(listener)
  return () => {
    agentTaskCompleteTrackingEnabledListeners.delete(listener)
    if (
      agentTaskCompleteTrackingEnabledListeners.size === 0 &&
      agentTaskCompleteTrackingSettingsUnsubscribe !== null
    ) {
      agentTaskCompleteTrackingSettingsUnsubscribe()
      agentTaskCompleteTrackingSettingsUnsubscribe = null
      agentTaskCompleteTrackingSettingsSnapshot = null
    }
  }
}

function recordPtyConnectDiagnostic(message: string): void {
  if (!e2eConfig.exposeStore) {
    return
  }
  console.log(`[pty-connect] ${message}`)
  const target = globalThis as Record<string, unknown>
  const diag = (target.__ptyConnectDiag ??= [] as string[]) as string[]
  diag.push(message)
  if (diag.length > PTY_CONNECT_DIAG_LIMIT) {
    diag.splice(0, diag.length - PTY_CONNECT_DIAG_LIMIT)
  }
}

// Why: when multiple panes/tabs need the same deferred SSH connection,
// the first one calls ssh.connect() and subsequent ones must wait for it
// rather than returning early (which would leave them disconnected). This
// helper either connects or waits for an in-flight connect to finish.
type SshConnectResult = { connected: true } | { connected: false; error: string }
type UserInitiatedSshConnectOutcome = 'connected' | 'cancelled' | 'failed'

const sshConnectPromises = new Map<string, Promise<SshConnectResult>>()

function isSshSessionExpiredError(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes(SSH_SESSION_EXPIRED_ERROR)
}

function isRemoteRuntimePtyId(ptyId: string | null | undefined): boolean {
  return typeof ptyId === 'string' && ptyId.startsWith(REMOTE_PTY_ID_PREFIX)
}

function consumeInactiveForegroundImmediateBudget(dataLength: number): boolean {
  const now = performance.now()
  if (now - inactiveForegroundImmediateBudgetWindowStart > FOREGROUND_BUDGET_WINDOW_MS) {
    inactiveForegroundImmediateBudgetChars = 0
    inactiveForegroundImmediateBudgetWindowStart = now
  }
  if (
    inactiveForegroundImmediateBudgetChars + dataLength >
    INACTIVE_FOREGROUND_IMMEDIATE_BUDGET_CHARS
  ) {
    return false
  }
  inactiveForegroundImmediateBudgetChars += dataLength
  return true
}

function hasCodexRestartNotices(
  noticesByPtyId: Record<string, { previousAccountLabel: string; nextAccountLabel: string }>
): boolean {
  if (codexRestartNoticePresenceSource !== noticesByPtyId) {
    codexRestartNoticePresenceSource = noticesByPtyId
    codexRestartNoticePresence = Object.keys(noticesByPtyId).length > 0
  }
  return codexRestartNoticePresence
}

function sshPromptConnectOutcomeForStatus(
  status: string | undefined,
  sawNonDisconnected: boolean
): UserInitiatedSshConnectOutcome | null {
  if (status === 'connected') {
    return 'connected'
  }
  if (status === 'auth-failed' || status === 'error' || status === 'reconnection-failed') {
    return 'failed'
  }
  // Why: this only counts after a real connect attempt; the entry-time
  // disconnected state just means the user still needs to initiate auth.
  if (sawNonDisconnected && status === 'disconnected') {
    return 'cancelled'
  }
  return null
}

async function waitForSshConnection(connectionId: string): Promise<SshConnectResult> {
  const state = useAppStore.getState().sshConnectionStates.get(connectionId)
  if (state?.status === 'connected') {
    return { connected: true }
  }

  const existing = sshConnectPromises.get(connectionId)
  if (existing) {
    return existing
  }

  const promise: Promise<SshConnectResult> = (async (): Promise<SshConnectResult> => {
    try {
      await window.api.ssh.connect({ targetId: connectionId })
      return { connected: true }
    } catch (err) {
      console.warn(`Deferred SSH reconnect failed for ${connectionId}:`, err)
      return {
        connected: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      sshConnectPromises.delete(connectionId)
    }
  })()

  sshConnectPromises.set(connectionId, promise)
  return promise
}

function isCodexPaneStale(args: {
  tabId: string
  worktreeId: string
  panePtyId: string | null
}): boolean {
  const state = useAppStore.getState()
  const { codexRestartNoticeByPtyId } = state
  if (!hasCodexRestartNotices(codexRestartNoticeByPtyId)) {
    return false
  }
  if (args.panePtyId && codexRestartNoticeByPtyId[args.panePtyId]) {
    return true
  }

  const tab = (state.tabsByWorktree[args.worktreeId] ?? []).find((entry) => entry.id === args.tabId)
  if (tab?.ptyId && codexRestartNoticeByPtyId[tab.ptyId]) {
    return true
  }

  return false
}

// Why: daemon session IDs use the format `${worktreeId}@@${shortUuid}`.
// This validates that a session ID actually belongs to the given worktree,
// preventing cross-workspace contamination during restore.
function isSessionOwnedByWorktree(sessionId: string, worktreeId: string): boolean {
  const separatorIdx = sessionId.lastIndexOf('@@')
  if (separatorIdx === -1) {
    return true
  }
  return sessionId.slice(0, separatorIdx) === worktreeId
}

function shouldWritePtyOutputForeground(isPaneVisible: boolean): boolean {
  if (!isPaneVisible) {
    return false
  }
  if (typeof document === 'undefined') {
    return true
  }
  // Why: Electron can keep visible panes mounted while the whole app is
  // backgrounded. Treat hidden documents like background tabs so Chromium
  // timer throttling cannot pin terminal writes on the renderer foreground path.
  if (document.visibilityState === 'visible') {
    return true
  }
  // Why: macOS occlusion tracking can wedge visibilityState at 'hidden' after
  // display sleep; proven-stale means real user input contradicted it, so the
  // hidden-delivery gate must not keep dropping a watched pane's bytes.
  return isDocumentVisibilityProvenStale()
}

function containsSynchronizedOutputStart(data: string): boolean {
  return data.includes(SYNCHRONIZED_OUTPUT_START_SEQUENCE)
}

function containsSynchronizedOutputEnd(data: string): boolean {
  return data.includes(SYNCHRONIZED_OUTPUT_END_SEQUENCE)
}

function shouldSynchronizedOutputRemainActive(data: string, wasActive: boolean): boolean {
  const lastStartIndex = data.lastIndexOf(SYNCHRONIZED_OUTPUT_START_SEQUENCE)
  const lastEndIndex = data.lastIndexOf(SYNCHRONIZED_OUTPUT_END_SEQUENCE)
  if (lastStartIndex === -1 && lastEndIndex === -1) {
    return wasActive
  }
  return lastStartIndex > lastEndIndex
}

function containsCursorPositionSequence(data: string): boolean {
  let offset = data.indexOf('\x1b[')
  while (offset !== -1) {
    let index = offset + 2
    while (index < data.length) {
      const char = data[index]
      if (char === 'G' || char === 'H' || char === 'f') {
        return true
      }
      if ((char < '0' || char > '9') && char !== ';') {
        break
      }
      index += 1
    }
    offset = data.indexOf('\x1b[', offset + 2)
  }
  return false
}

function containsCursorRestore(data: string): boolean {
  const hideIndex = data.indexOf(CURSOR_HIDE_SEQUENCE)
  const showIndex = data.lastIndexOf(CURSOR_SHOW_SEQUENCE)
  return hideIndex !== -1 && showIndex > hideIndex && containsCursorPositionSequence(data)
}

const SPLIT_GEOMETRY_EPSILON_PX = 1

function readElementRect(element: HTMLElement | null | undefined): DOMRect | null {
  try {
    return element?.getBoundingClientRect?.() ?? null
  } catch {
    return null
  }
}

function hasVisibleRect(rect: DOMRect | null): rect is DOMRect {
  return Boolean(
    rect && rect.width > SPLIT_GEOMETRY_EPSILON_PX && rect.height > SPLIT_GEOMETRY_EPSILON_PX
  )
}

function readProposedPaneGrid(pane: ManagedPane): { cols: number; rows: number } | null {
  try {
    const dimensions = pane.fitAddon.proposeDimensions()
    if (!dimensions || dimensions.cols <= 0 || dimensions.rows <= 0) {
      return null
    }
    return dimensions
  } catch {
    return null
  }
}

function isPaneGridAlignedWithFit(pane: ManagedPane): boolean {
  const proposed = readProposedPaneGrid(pane)
  return Boolean(
    proposed && pane.terminal.cols === proposed.cols && pane.terminal.rows === proposed.rows
  )
}

function isSetupSplitGeometryReady(
  pane: ManagedPane,
  manager: PaneManager,
  direction: SetupSplitDirection
): boolean {
  const splitElement = pane.container.parentElement
  const directionClass = direction === 'vertical' ? 'is-vertical' : 'is-horizontal'
  if (
    !splitElement?.classList?.contains('pane-split') ||
    !splitElement.classList.contains(directionClass)
  ) {
    return false
  }

  const sibling = manager
    .getPanes()
    .find(
      (candidate) => candidate.id !== pane.id && candidate.container.parentElement === splitElement
    )
  const splitRect = readElementRect(splitElement)
  const paneRect = readElementRect(pane.container)
  const siblingRect = readElementRect(sibling?.container)
  if (!hasVisibleRect(splitRect) || !hasVisibleRect(paneRect) || !hasVisibleRect(siblingRect)) {
    return false
  }

  const splitAxis = direction === 'vertical' ? splitRect.width : splitRect.height
  const paneAxis = direction === 'vertical' ? paneRect.width : paneRect.height
  const siblingAxis = direction === 'vertical' ? siblingRect.width : siblingRect.height
  return (
    paneAxis > SPLIT_GEOMETRY_EPSILON_PX &&
    siblingAxis > SPLIT_GEOMETRY_EPSILON_PX &&
    splitAxis - paneAxis > SPLIT_GEOMETRY_EPSILON_PX &&
    splitAxis - siblingAxis > SPLIT_GEOMETRY_EPSILON_PX &&
    isPaneGridAlignedWithFit(pane)
  )
}

/**
 * Establishes a binding between a terminal pane and its corresponding PTY stream,
 * managing input, output, title synchronization, and agent status tracking.
 */
export function connectPanePty(
  pane: ManagedPane,
  manager: PaneManager,
  deps: PtyConnectionDeps
): PanePtyBinding {
  const shouldRefreshForegroundSynchronously = (): boolean => !manager.hasWebglRenderer(pane.id)
  // Why: recovery ownership belongs to this xterm instance. A request that
  // settles after remount must not remount its already-replaced successor.
  const terminalRecoveryGeneration = captureTerminalPaneRecoveryGeneration(deps.tabId)
  const terminalRecoveryInstance = registerTerminalPaneRecoveryInstance(deps.tabId)
  exposeE2eTerminalPtyOutputDebug()
  let disposed = false
  const structuralReplayCoordinator = createTerminalStructuralReplayCoordinator(pane.terminal)
  let connectFrame: number | null = null
  let connectFallbackTimer: ReturnType<typeof setTimeout> | null = null
  let startupGridSettleHandle: TerminalStartupGridSettleHandle | null = null
  let startupGridSettledForConnect = false
  let connectStarted = false
  let unregisterBacklogRecovery: (() => void) | null = null
  let unregisterDocumentVisibilityRecovery: (() => void) | null = null
  let cancelHiddenOutputSnapshotScrollRestore = (): void => {}
  let pendingHiddenSnapshotFit: SafeFitContinuationHandle | null = null
  let pendingReattachFit: SafeFitContinuationHandle | null = null
  let cancelFreshSpawnFollowReset = (): void => {}
  let cleanupHiddenOutputRestoreDeferredRetry = (): void => {}
  let cleanupHiddenOutputRestoreForegroundDeadline = (): void => {}
  let cleanupHiddenOutputRestoreFloodRepaint = (): void => {}
  let resetRendererOrderedSeqForPtyExit: (exitedPtyId: string) => void = () => {}
  let cleanupStartupDraftPasteTimers = (): void => {}
  let unregisterE2ePtyDataInjection = (): void => {}
  let startupInjectTimer: ReturnType<typeof setTimeout> | null = null
  let sshShellReadyFallbackTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteNotificationGraceTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteNotificationMaxTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteStatusUnsubscribe: (() => void) | null = null
  let agentTaskCompleteSettingsUnsubscribe: (() => void) | null = null
  let agentTaskCompleteNotificationGeneration = 0
  let wasAgentTaskCompleteTrackingEnabled = isAgentTaskCompleteTrackingEnabled()
  let requiresFreshWorkingForAgentTaskCompleteNotification = !wasAgentTaskCompleteTrackingEnabled
  let wasAgentTaskCompleteOsNotificationEnabled = isAgentTaskCompleteNotificationEnabled()
  let terminalBellNotificationTimer: ReturnType<typeof setTimeout> | null = null
  let pendingTerminalBellNotification = false
  let reattachIdleAgentCursorResetTimer: ReturnType<typeof setTimeout> | null = null
  let alternateScreenBackgroundRepaintTimer: ReturnType<typeof setTimeout> | null = null
  let shiftEnterReconfirmTimer: ReturnType<typeof setTimeout> | null = null
  let synchronizedForegroundOutputActive = false
  // Why: tracks the keystroke proximity captured when the current synchronized
  // foreground frame opened, so a split end marker that lands after the redraw
  // window still drains on the fast path instead of the 1s coalesce fallback.
  let synchronizedForegroundFrameInteractive = false
  let suppressStructuralReplayPtyResize = false
  // Why: hidden-delivery gate sync is wired up alongside the deferred PTY
  // output plumbing inside the connect frame; lifecycle hooks (visibility
  // flips, exit, dispose) run before/after it exists, so start with no-ops.
  let syncHiddenRendererPtyDelivery: () => void = () => {}
  let releaseHiddenRendererPtyDelivery: () => void = () => {}
  let suppressViewportClaimTerminalResize = false
  // Why: idle callbacks are registered before the deferred PTY output plumbing
  // exists. Start with the shared scheduler, then switch to the PTY writer
  // below so hidden-tab resets keep backlog-recovery callbacks and byte order.
  let idleAgentTerminalModeReset = RESET_TERMINAL_CURSOR_STYLE
  let suppressNativeWindowsIdleCodexFocusReports = false
  const setFocusReportSuppressionForAgentCompletion = (
    title: string | undefined,
    agentType: AgentType | undefined
  ): void => {
    const titleAgentType = resolveCommittedTitleAgentType(title ?? '')
    suppressNativeWindowsIdleCodexFocusReports =
      agentType && agentType !== 'unknown' ? agentType === 'codex' : titleAgentType === 'codex'
  }
  let queueAgentIdleTerminalModeReset = (): void => {
    if (disposed) {
      return
    }
    writeTerminalOutput(pane.terminal, idleAgentTerminalModeReset, {
      foreground: shouldWritePtyOutputForeground(deps.isVisibleRef.current)
    })
  }
  // Why: passphrase-gate waits register a teardown here so dispose() can
  // actively unsubscribe + resolve them. Without this, a pane disposed
  // mid-wait leaks its zustand subscriber and the surrounding async IIFE
  // forever, since the subscriber's `disposed` check only fires when the
  // store next emits — which may never happen after disconnect.
  const waitTeardowns: (() => void)[] = []
  // Why: startup commands must only run once — in the pane they were
  // targeted at. Capture `deps.startup` into a local and clear the field on
  // the (already spread-copied) `deps` so nothing else inside this function
  // can accidentally re-read it. The caller is responsible for clearing its
  // own outer reference, since `deps` here is a shallow copy and our
  // mutation does not propagate back.
  const paneStartup = deps.startup ?? null
  deps.startup = undefined

  // Why: paneKey crosses PTY env, hook IPC, retained rows, and reload/replay.
  // Use the stable layout leaf UUID, not the renderer-local numeric pane id.
  const cacheKey = makePaneKey(deps.tabId, pane.leafId)
  // Why: mirrors the kitty keyboard flags the pane's application negotiates.
  // Fed only from application output (live PTY bytes + daemon replay
  // payloads), never from renderer-generated resets, so it reflects what the
  // application expects even after defensive renderer-side kitty wipes.
  const kittyKeyboardModes = (() => {
    const existing = deps.paneKittyKeyboardModesRef.current.get(pane.id)
    if (existing) {
      return existing
    }
    const created = new TerminalKittyKeyboardModeTracker()
    deps.paneKittyKeyboardModesRef.current.set(pane.id, created)
    return created
  })()
  const getSleepingRecordForPane = (
    state: ReturnType<typeof useAppStore.getState>
  ): { paneKey: string; record: SleepingAgentSessionRecord } | null => {
    const stableRecord = state.sleepingAgentSessionsByPaneKey[cacheKey]
    if (stableRecord) {
      return { paneKey: cacheKey, record: stableRecord }
    }
    const legacyMatches = Object.entries(state.sleepingAgentSessionsByPaneKey).filter(
      ([paneKey, record]) => {
        const legacy = parseLegacyNumericPaneKey(paneKey)
        return (
          legacy?.tabId === deps.tabId &&
          record.worktreeId === deps.worktreeId &&
          (!record.tabId || record.tabId === deps.tabId)
        )
      }
    )
    const exactLegacyMatch = legacyMatches.find(([paneKey]) => {
      const legacy = parseLegacyNumericPaneKey(paneKey)
      return legacy?.numericPaneId === String(pane.id)
    })
    const providerSessionKeys = new Set(
      legacyMatches.map(([, record]) => getProviderSessionClaimKey(record))
    )
    const oldestLegacyMatch = legacyMatches
      .slice()
      .sort(([, a], [, b]) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)[0]
    // Why: duplicate legacy aliases can point at one provider session; consume
    // the oldest capture as canonical and clear its aliases after resume.
    const selectedLegacyMatch =
      exactLegacyMatch ??
      (providerSessionKeys.size === 1
        ? legacyMatches.length === 1
          ? legacyMatches[0]
          : oldestLegacyMatch
        : null)
    if (!selectedLegacyMatch) {
      return null
    }
    const [paneKey, record] = selectedLegacyMatch
    return { paneKey, record }
  }
  const clearSleepingRecordProviderDuplicates = (
    state: ReturnType<typeof useAppStore.getState>,
    consumed: { paneKey: string; record: SleepingAgentSessionRecord }
  ): void => {
    state.clearSleepingAgentSession(consumed.paneKey)
    for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey)) {
      if (
        paneKey !== consumed.paneKey &&
        record.worktreeId === consumed.record.worktreeId &&
        record.agent === consumed.record.agent &&
        agentProviderSessionsEqual(
          record.agent,
          record.providerSession,
          consumed.record.providerSession
        )
      ) {
        // Why: legacy pane aliases can leave multiple sleeping rows for one
        // provider session; once this pane resumes it, every alias is stale.
        state.clearSleepingAgentSession(paneKey)
      }
    }
  }
  const launchToken = paneStartup?.launchConfig
    ? (paneStartup.launchToken ?? createBrowserUuid())
    : undefined
  const startupDraftAgent = paneStartup?.launchAgent ?? paneStartup?.initialAgentStatus?.agent
  const startupDraftAgentConfig = startupDraftAgent ? TUI_AGENT_CONFIG[startupDraftAgent] : null
  const startupDraftPrompt =
    typeof paneStartup?.draftPrompt === 'string' && paneStartup.draftPrompt.trim()
      ? paneStartup.draftPrompt
      : null
  const startupDraftPromptNeedsPaste =
    startupDraftPrompt !== null &&
    !startupDraftAgentConfig?.draftPromptFlag &&
    !startupDraftAgentConfig?.draftPromptEnvVar
  let startupDraftDeliveryClaimed = false
  let startupDraftPasteAttempted = false
  const claimStartupDraftPasteDelivery = (): boolean => {
    if (!startupDraftPromptNeedsPaste || launchToken === undefined) {
      return false
    }
    if (startupDraftDeliveryClaimed) {
      return true
    }
    // Why: launch-bound draft paste needs a launch token; all current
    // draftPrompt startup callers pair it with launchConfig so this can safely
    // fence off delayed sidecar delivery before Codex's first composer frame.
    startupDraftDeliveryClaimed = beginAgentStartupDeliveryAttempt({
      worktreeId: deps.worktreeId,
      tabId: deps.tabId,
      launchToken
    })
    return startupDraftDeliveryClaimed
  }
  const releaseUnattemptedStartupDraftPasteDelivery = (): void => {
    if (!startupDraftDeliveryClaimed || startupDraftPasteAttempted || launchToken === undefined) {
      return
    }
    releaseAgentStartupDeliveryAttempt({
      worktreeId: deps.worktreeId,
      tabId: deps.tabId,
      launchToken
    })
    startupDraftDeliveryClaimed = false
  }
  if (paneStartup?.launchConfig) {
    useAppStore.getState().registerAgentLaunchConfig(cacheKey, paneStartup.launchConfig, {
      agentType: paneStartup.launchAgent ?? paneStartup.initialAgentStatus?.agent,
      ...(launchToken ? { launchToken } : {}),
      tabId: deps.tabId,
      leafId: pane.leafId
    })
  } else if (paneStartup) {
    useAppStore.getState().clearAgentLaunchConfig(cacheKey)
  }
  const registerEffectiveLaunchConfig = (
    effectiveLaunchConfig: PtyConnectResult['launchConfig'] | undefined,
    metadata?: { launchToken?: string; launchAgent?: TuiAgent }
  ): void => {
    if (!effectiveLaunchConfig) {
      if (metadata?.launchAgent) {
        // Why: daemon launch identity can outlive the process while Orca is
        // closed. Use it to request confirmation, never as current byte authority.
        useAppStore.getState().setPaneForegroundAgent(cacheKey, {
          agent: metadata.launchAgent,
          shellForeground: false
        })
      }
      return
    }
    // Why: daemon reattach preserves the pane's exact launch command but not
    // renderer metadata; recover only allowlisted command identity from it.
    const persistedLaunchAgent = recognizeAgentProcessFromCommandLine(
      effectiveLaunchConfig.agentCommand
    )?.agent
    useAppStore.getState().registerAgentLaunchConfig(cacheKey, effectiveLaunchConfig, {
      agentType:
        metadata?.launchAgent ??
        paneStartup?.launchAgent ??
        paneStartup?.initialAgentStatus?.agent ??
        persistedLaunchAgent,
      ...((metadata?.launchToken ?? launchToken)
        ? { launchToken: metadata?.launchToken ?? launchToken }
        : {}),
      tabId: deps.tabId,
      leafId: pane.leafId
    })
  }
  const clearRegisteredStartupLaunchConfig = (): void => {
    useAppStore.getState().clearAgentLaunchConfig(cacheKey)
  }
  const pendingSpawnKey = cacheKey
  const neutralTerminalTitle = (): string => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find(
      (entry) => entry.id === deps.tabId
    )
    return tab?.defaultTitle?.trim() || 'Terminal'
  }
  // Why: infer pane ownership from a manually typed agent command (e.g. `omp`) by
  // shadowing the shell's current command line, for generic terminals where no
  // launch metadata exists. Consumed by getAuthoritativePaneAgent below.
  let commandInferredPaneAgent: TuiAgent | null = null
  let pendingShellCommandLine = ''
  let pendingShellCommandCursor = 0
  let commandInferredPaneAgentGeneration = 0
  let shellCommandInferenceSuspendedUntilCommandEnd = false
  let startAcceptedInferredCommand = (_agent: TuiAgent): void => {}
  let requestKnownDroidReconfirmation = (): void => {}
  const resetPendingShellCommandLine = (): void => {
    pendingShellCommandLine = ''
    pendingShellCommandCursor = 0
  }
  const rememberCommandInferredPaneAgent = (): void => {
    const commandLine = pendingShellCommandLine.trim()
    resetPendingShellCommandLine()
    const candidateAgent = commandLine
      ? (recognizeAgentProcessFromCommandLine(commandLine)?.agent ?? null)
      : null
    const state = useAppStore.getState()
    const registeredLaunchAgent = state.agentLaunchConfigByPaneKey[cacheKey]?.identity.agentType
    // Why: input inside a live TUI can spell another agent command; process or
    // pane-scoped launch ownership is stronger than typed shell inference.
    const nextAgent =
      state.paneForegroundAgentByPaneKey[cacheKey]?.agent || isTuiAgent(registeredLaunchAgent)
        ? null
        : candidateAgent
    commandInferredPaneAgent = nextAgent
    commandInferredPaneAgentGeneration += 1
    if (nextAgent) {
      startAcceptedInferredCommand(nextAgent)
    }
  }
  const clearCommandInferredPaneAgent = (): void => {
    commandInferredPaneAgent = null
    resetPendingShellCommandLine()
    commandInferredPaneAgentGeneration += 1
  }
  const clearCommandInferredPaneAgentAfterPtySideEffects = (): void => {
    const generation = commandInferredPaneAgentGeneration
    resetPendingShellCommandLine()
    queueMicrotask(() => {
      setTimeout(() => {
        if (commandInferredPaneAgentGeneration === generation) {
          clearCommandInferredPaneAgent()
        }
      }, 0)
    })
  }
  const appendPendingShellCommandInput = (text: string): void => {
    const available = MANUAL_AGENT_COMMAND_MAX_CHARS - pendingShellCommandLine.length
    if (available <= 0) {
      shellCommandInferenceSuspendedUntilCommandEnd = true
      return
    }
    const inserted = text.slice(0, available)
    pendingShellCommandLine =
      pendingShellCommandLine.slice(0, pendingShellCommandCursor) +
      inserted +
      pendingShellCommandLine.slice(pendingShellCommandCursor)
    pendingShellCommandCursor += inserted.length
    if (inserted.length < text.length) {
      shellCommandInferenceSuspendedUntilCommandEnd = true
    }
  }
  const deletePendingShellCommandWord = (): void => {
    const beforeCursor = pendingShellCommandLine.slice(0, pendingShellCommandCursor)
    const afterCursor = pendingShellCommandLine.slice(pendingShellCommandCursor)
    const nextBeforeCursor = beforeCursor.replace(/[^\S\r\n]*\S+[^\S\r\n]*$/, '')
    pendingShellCommandLine = nextBeforeCursor + afterCursor
    pendingShellCommandCursor = nextBeforeCursor.length
  }
  const cancelSuspendedShellCommandInference = (): void => {
    if (!shellCommandInferenceSuspendedUntilCommandEnd) {
      return
    }
    shellCommandInferenceSuspendedUntilCommandEnd = false
    resetPendingShellCommandLine()
  }
  const deletePendingShellCommandCharacter = (): void => {
    if (pendingShellCommandCursor === 0) {
      return
    }
    pendingShellCommandLine =
      pendingShellCommandLine.slice(0, pendingShellCommandCursor - 1) +
      pendingShellCommandLine.slice(pendingShellCommandCursor)
    pendingShellCommandCursor -= 1
  }
  const deletePendingShellCommandCharacterAtCursor = (): void => {
    if (pendingShellCommandCursor >= pendingShellCommandLine.length) {
      return
    }
    pendingShellCommandLine =
      pendingShellCommandLine.slice(0, pendingShellCommandCursor) +
      pendingShellCommandLine.slice(pendingShellCommandCursor + 1)
  }
  const movePendingShellCommandCursor = (delta: number): void => {
    pendingShellCommandCursor = Math.min(
      pendingShellCommandLine.length,
      Math.max(0, pendingShellCommandCursor + delta)
    )
  }
  const consumeShellCommandCsiSequence = (data: string, index: number): number | null => {
    if (data.charCodeAt(index) !== 0x1b || data[index + 1] !== '[') {
      return null
    }
    let cursor = index + 2
    while (cursor < data.length && /[0-9;?]/.test(data[cursor]!)) {
      cursor += 1
    }
    const final = data[cursor]
    if (!final || !/[~A-Za-z]/.test(final)) {
      return null
    }
    const params = data.slice(index + 2, cursor)
    // Why: only emulate a bare one-column move. Parameterized/modified cursor keys
    // (e.g. Ctrl+Left `\x1b[1;5D` = word-jump) move the real cursor by more than
    // one, so tracking them as ±1 would desync the shadow line — fall through to
    // reset instead of silently corrupting the sampled command.
    if (final === 'D' && params === '') {
      movePendingShellCommandCursor(-1)
    } else if (final === 'C' && params === '') {
      movePendingShellCommandCursor(1)
    } else if (final === 'H' || (final === '~' && params === '1')) {
      pendingShellCommandCursor = 0
    } else if (final === 'F' || (final === '~' && params === '4')) {
      pendingShellCommandCursor = pendingShellCommandLine.length
    } else if (final === '~' && params === '3') {
      deletePendingShellCommandCharacterAtCursor()
    } else if (final === '~' && (params === '200' || params === '201')) {
      // Bracketed paste wrappers are terminal framing, not shell command text.
    } else {
      resetPendingShellCommandLine()
    }
    return cursor + 1
  }
  const getLivePaneAgentTitle = (): string | null => {
    const state = useAppStore.getState()
    const runtimeTitle = state.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
    const tabTitle = (state.tabsByWorktree[deps.worktreeId] ?? []).find(
      (entry) => entry.id === deps.tabId
    )?.title
    return runtimeTitle ?? tabTitle ?? null
  }
  // Why: a pane-scoped explicit row only counts as current ownership evidence
  // when it is fresh and not already `done` — a stale or completed row is a
  // leftover from a prior agent that may no longer own the shell.
  const isFreshActivePaneAgentEntry = (
    entry: AgentStatusEntry | undefined
  ): entry is AgentStatusEntry => {
    return isFreshNonDoneAgentStatus(entry)
  }
  const shouldSuppressTitleCompletionForFreshHook = (
    title: string,
    activeHookStatus: AgentStatusEntry | undefined
  ): boolean => {
    if (
      detectAgentStatusFromTitle(title) === 'working' ||
      !isFreshNonDoneAgentStatus(activeHookStatus)
    ) {
      return false
    }
    const explicitTitleAgentType = resolveCommittedTitleAgentType(title)
    const activeHookAgentForTitle = resolveCompatibleAgentTypeForOwner(
      activeHookStatus?.agentType,
      explicitTitleAgentType
    )
    const titleNamesDifferentKnownAgent =
      explicitTitleAgentType &&
      activeHookStatus?.agentType &&
      activeHookStatus.agentType !== 'unknown' &&
      activeHookAgentForTitle !== explicitTitleAgentType
    return !titleNamesDifferentKnownAgent
  }
  let pendingSuppressedTitleSideEffects: {
    title: string
    agentType: AgentType | undefined
  } | null = null
  const clearSuppressedTitleSideEffects = (): void => {
    pendingSuppressedTitleSideEffects = null
  }
  const applyAgentCompletionSideEffects = (
    title: string,
    agentType: AgentType | undefined
  ): void => {
    const settings = useAppStore.getState().settings
    if (
      (agentType === 'claude' || isClaudeAgent(title)) &&
      (settings === null || settings.promptCacheTimerEnabled)
    ) {
      deps.setCacheTimerStartedAt(cacheKey, Date.now())
    }
    setFocusReportSuppressionForAgentCompletion(title, agentType)
    queueAgentIdleTerminalModeReset()
  }
  const preserveSuppressedTitleSideEffects = (
    title: string,
    activeHookStatus: AgentStatusEntry
  ): void => {
    pendingSuppressedTitleSideEffects = {
      title,
      agentType: activeHookStatus.agentType
    }
    if (activeHookStatus.state === 'waiting' || activeHookStatus.state === 'blocked') {
      suppressNativeWindowsIdleCodexFocusReports = false
      queueAgentIdleTerminalModeReset()
    }
  }
  const handleAgentHookTerminalLifecycle = (payload: AgentCompletionStatusSnapshot): void => {
    const pending = pendingSuppressedTitleSideEffects
    if (!pending) {
      return
    }
    const payloadAgentForPending = resolveCompatibleAgentTypeForOwner(
      payload.agentType,
      pending.agentType
    )
    const belongsToPendingAgent =
      !pending.agentType ||
      pending.agentType === 'unknown' ||
      !payload.agentType ||
      payload.agentType === 'unknown' ||
      payloadAgentForPending === pending.agentType
    if (!belongsToPendingAgent || payload.state === 'working') {
      clearSuppressedTitleSideEffects()
      return
    }
    if (payload.state === 'done') {
      applyAgentCompletionSideEffects(pending.title, payload.agentType ?? pending.agentType)
      clearSuppressedTitleSideEffects()
      return
    }
    if (payload.state === 'waiting' || payload.state === 'blocked') {
      suppressNativeWindowsIdleCodexFocusReports = false
      queueAgentIdleTerminalModeReset()
    }
  }
  const unregisterAgentHookTerminalLifecycle = registerAgentHookTerminalLifecycleHandler(
    cacheKey,
    handleAgentHookTerminalLifecycle
  )
  const hasFreshPaneAgentSurface = (): boolean => {
    const entry = useAppStore.getState().agentStatusByPaneKey[cacheKey]
    if (isFreshActivePaneAgentEntry(entry)) {
      return true
    }
    const liveTitle = getLivePaneAgentTitle()
    return detectAgentStatusFromTitle(liveTitle ?? '') !== null
  }
  const observeAcceptedShellCommandInput = (data: string): void => {
    if (
      data.includes('\r') ||
      data.includes('\n') ||
      data.includes('\x03') ||
      data.includes('\x04')
    ) {
      // Why: shells without OSC 133 give no command/exit boundary. An accepted
      // submit or interrupt revokes only stale Droid routing and confirms once.
      requestKnownDroidReconfirmation()
    }
    if (commandInferredPaneAgent) {
      return
    }
    // Why: bytes typed inside a live agent TUI are prompt text, not shell
    // commands, even if they spell another agent binary name.
    if (hasFreshPaneAgentSurface()) {
      resetPendingShellCommandLine()
      return
    }
    if (shellCommandInferenceSuspendedUntilCommandEnd) {
      if (data.includes('\x03') || data.includes('\x15')) {
        shellCommandInferenceSuspendedUntilCommandEnd = false
        resetPendingShellCommandLine()
      }
      if (data.includes('\r') || data.includes('\n')) {
        shellCommandInferenceSuspendedUntilCommandEnd = false
      }
      return
    }
    if (data.length > MANUAL_AGENT_COMMAND_MAX_CHARS) {
      resetPendingShellCommandLine()
      shellCommandInferenceSuspendedUntilCommandEnd = !data.includes('\r') && !data.includes('\n')
      return
    }
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]!
      if (char === '\r' || char === '\n') {
        shellCommandInferenceSuspendedUntilCommandEnd = false
        rememberCommandInferredPaneAgent()
        if (commandInferredPaneAgent) {
          return
        }
        continue
      }
      if (char === '\x7f' || char === '\b') {
        deletePendingShellCommandCharacter()
        continue
      }
      if (char === '\x17') {
        deletePendingShellCommandWord()
        continue
      }
      if (char === '\x03' || char === '\x15') {
        resetPendingShellCommandLine()
        continue
      }
      if (char === '\x1b') {
        const nextIndex = consumeShellCommandCsiSequence(data, index)
        if (nextIndex !== null) {
          index = nextIndex - 1
          continue
        }
        resetPendingShellCommandLine()
        continue
      }
      if (char < ' ') {
        resetPendingShellCommandLine()
        continue
      }
      if (char >= ' ') {
        appendPendingShellCommandInput(char)
        if (shellCommandInferenceSuspendedUntilCommandEnd) {
          return
        }
      }
    }
  }
  /**
   * Resolves the authoritative owner agent type for this pane, checking tab launch,
   * pane startup, typed command ownership, and store state configuration.
   *
   * Why: launch ownership wins so Pi-compatible live titles/hooks can't repaint an
   * OMP-owned pane back to Pi; command ownership covers manually typed `omp`
   * in generic terminals where launch metadata does not exist.
   */
  const getAuthoritativePaneAgent = (): AgentType | undefined => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find(
      (entry) => entry.id === deps.tabId
    )
    return (
      resolvePaneAgentOwner({
        launchAgent: tab?.launchAgent,
        startupLaunchAgent: paneStartup?.launchAgent,
        initialStatusAgent: paneStartup?.initialAgentStatus?.agent,
        commandInferredAgent: commandInferredPaneAgent,
        hookAgent: state.agentStatusByPaneKey[cacheKey]?.agentType
      }) ?? undefined
    )
  }
  // Why: the renderer veto (owner evidence beating a Gemini-looking title) must
  // use only pane-scoped, CURRENT ownership. getAuthoritativePaneAgent leads
  // with the tab-shared `tab.launchAgent` and a never-cleared
  // `paneStartup.launchAgent`, which would let a sibling split pane or a reused
  // pane keep WebGL for a genuine Gemini terminal (#7428 regression class).
  // Launch identity is excluded, and the never-clearing startup seed
  // (`paneStartup.initialAgentStatus`) too; a stale or `done` explicit row is
  // ignored via the freshness predicate so a reused pane cannot inherit a prior
  // agent's veto. Only live foreground command inference and a fresh, active
  // hook row count. A genuine OMP/Pi pane stays protected owner-independently by
  // the isPiAgentTitle guard inside isGeminiTerminalTitle.
  const getPaneScopedRendererOwner = (): AgentType | undefined => {
    const entry = useAppStore.getState().agentStatusByPaneKey[cacheKey]
    return (
      commandInferredPaneAgent ?? (isFreshActivePaneAgentEntry(entry) ? entry.agentType : undefined)
    )
  }
  const clearInferredInterruptWorkingTitle = (): void => {
    const state = useAppStore.getState()
    const currentTitle = state.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
    const statusTitle = state.agentStatusByPaneKey[cacheKey]?.terminalTitle
    const title = currentTitle ?? statusTitle
    if (!title) {
      return
    }
    const neutralTitle = neutralTerminalTitle()
    // Why: inferred interrupts update the explicit hook row, but many CLIs leave
    // their OSC title stuck on a working spinner. Replace only this fallback
    // title signal with a neutral terminal label so the existing process tracker
    // can still decide whether an agent TUI is truly alive.
    deps.setRuntimePaneTitle(deps.tabId, pane.id, neutralTitle)
    if (manager.getActivePane()?.id === pane.id) {
      deps.updateTabTitle(deps.tabId, neutralTitle)
    }
  }
  let titleOnlyInterruptTimer: ReturnType<typeof setTimeout> | null = null
  const clearTitleOnlyInterruptTimer = (): void => {
    if (titleOnlyInterruptTimer !== null) {
      clearTimeout(titleOnlyInterruptTimer)
      titleOnlyInterruptTimer = null
    }
  }
  const observeTitleOnlyInterrupt = (): void => {
    const state = useAppStore.getState()
    if (state.agentStatusByPaneKey[cacheKey]) {
      return
    }
    const runtimeTitle = state.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
    const tabTitle = (state.tabsByWorktree[deps.worktreeId] ?? []).find(
      (entry) => entry.id === deps.tabId
    )?.title
    const baselineTitle = runtimeTitle ?? tabTitle
    if (detectAgentStatusFromTitle(baselineTitle ?? '') !== 'working') {
      return
    }
    clearTitleOnlyInterruptTimer()
    titleOnlyInterruptTimer = setTimeout(() => {
      titleOnlyInterruptTimer = null
      if (useAppStore.getState().agentStatusByPaneKey[cacheKey]) {
        return
      }
      const currentState = useAppStore.getState()
      const currentRuntimeTitle = currentState.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
      const currentTabTitle = (currentState.tabsByWorktree[deps.worktreeId] ?? []).find(
        (entry) => entry.id === deps.tabId
      )?.title
      const currentTitle = currentRuntimeTitle ?? currentTabTitle
      if (
        currentTitle === baselineTitle &&
        detectAgentStatusFromTitle(currentTitle ?? '') === 'working'
      ) {
        // Why: title-only agents such as Pi can miss their own idle title after
        // Ctrl+C. Clear only an unchanged, acknowledged working title.
        clearInferredInterruptWorkingTitle()
      }
    }, AGENT_INTERRUPT_SETTLE_MS)
  }
  const clearReattachIdleAgentCursorResetTimer = (): void => {
    if (reattachIdleAgentCursorResetTimer !== null) {
      clearTimeout(reattachIdleAgentCursorResetTimer)
      reattachIdleAgentCursorResetTimer = null
    }
  }
  const getCurrentTerminalTitle = (): string | null => {
    const state = useAppStore.getState()
    const runtimeTitle = state.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
    const tabTitle = (state.tabsByWorktree[deps.worktreeId] ?? []).find(
      (entry) => entry.id === deps.tabId
    )?.title
    return runtimeTitle ?? tabTitle ?? null
  }
  let reattachReplayPayloadHasCursorAgentSignal = false
  // Why: post-parse veto callbacks must only judge the latest replay frame; a
  // newer frame bumps the generation so a stale callback stands down.
  let reattachReplayPayloadSignalGeneration = 0
  const rememberReattachPayloadAgentSignal = (
    data: string,
    opts: { fullScreenReplay: boolean }
  ): void => {
    reattachReplayPayloadSignalGeneration += 1
    // Why: ordinary scrollback can mention agent names. Treat replay bytes as
    // a live Cursor Agent signal only when they look like its restored screen.
    const signal = hasCursorAgentReattachPayloadScreenSignal(data)
    // Why: incremental (non-clearing) replay frames repaint only part of the
    // screen, so their bytes can only add evidence — a full-screen replay is
    // the authoritative repaint that may clear the flag.
    reattachReplayPayloadHasCursorAgentSignal = opts.fullScreenReplay
      ? signal
      : reattachReplayPayloadHasCursorAgentSignal || signal
  }
  const isCursorAgentNativeTitle = (title: string): boolean => {
    return title.trim().toLowerCase() === CURSOR_AGENT_REATTACH_HEADER.toLowerCase()
  }
  const hasLiveAgentReattachStatusOrTitleSignal = (): boolean => {
    // Why: launch ownership (tab.launchAgent) never decays after the agent
    // exits, so it must not count as liveness here — only live status, live
    // titles, and the replayed screen shape do.
    if (useAppStore.getState().agentStatusByPaneKey[cacheKey]) {
      return true
    }
    const title = getCurrentTerminalTitle() ?? ''
    // Why: broad token matching (getAgentLabel) fires on titles like
    // "ssh devin@host"; that surface is too loose to gate mode preservation
    // and PTY byte injection, so only exact/status titles count here.
    return detectAgentStatusFromTitle(title) !== null || isCursorAgentNativeTitle(title)
  }
  const hasLiveAgentReattachSignal = (): boolean => {
    return hasLiveAgentReattachStatusOrTitleSignal() || reattachReplayPayloadHasCursorAgentSignal
  }
  const shouldPreserveAgentReattachModes = (): boolean => {
    // Why: ordinary shells can inherit stale ?25l/?1004h from replay bytes.
    // Preserve those modes only when reattach still looks agent-owned.
    return hasLiveAgentReattachSignal()
  }
  const shouldSendFocusedAgentReattachFocusIn = (): boolean => {
    return terminalOwnsDomFocus(pane.terminal) && shouldPreserveAgentReattachModes()
  }
  const scheduleReattachIdleAgentCursorReset = (): void => {
    const status = detectAgentStatusFromTitle(getCurrentTerminalTitle() ?? '')
    if (status !== 'idle' && status !== 'permission') {
      return
    }
    clearReattachIdleAgentCursorResetTimer()
    reattachIdleAgentCursorResetTimer = setTimeout(() => {
      reattachIdleAgentCursorResetTimer = null
      if (disposed) {
        return
      }
      const latestStatus = detectAgentStatusFromTitle(getCurrentTerminalTitle() ?? '')
      if (latestStatus !== 'idle' && latestStatus !== 'permission') {
        return
      }
      // Why: restored idle agent TUIs can repaint after reattach SIGWINCH and
      // reapply DECSCUSR steady-bar; the normal working→idle reset will not
      // fire because the agent was already idle before Orca restarted.
      queueAgentIdleTerminalModeReset()
    }, REATTACH_IDLE_AGENT_CURSOR_RESET_DELAY_MS)
  }
  const interruptInference = createAgentInterruptInference({
    paneKey: cacheKey,
    getStatusEntry: () => useAppStore.getState().agentStatusByPaneKey[cacheKey],
    inferInterrupt: (request) => {
      // Why: the explicit hook row is the authority for an in-flight agent turn.
      // Codex can reset its terminal title while handling Ctrl+C/Escape, so title
      // state must not veto clearing the row's working state.
      return window.api.agentStatus
        .inferInterrupt(request)
        .then((applied) => {
          if (applied) {
            clearInferredInterruptWorkingTitle()
          }
          return applied
        })
        .catch((err) => {
          console.warn('[agent-interrupt] inferInterrupt failed:', err)
          return false
        })
    }
  })
  const questionAnsweredInference = createAgentQuestionAnsweredInference({
    paneKey: cacheKey,
    getStatusEntry: () => useAppStore.getState().agentStatusByPaneKey[cacheKey],
    inferQuestionAnswered: (request) =>
      window.api.agentStatus.inferQuestionAnswered(request).catch((err) => {
        console.warn('[agent-question] inferQuestionAnswered failed:', err)
        return false
      })
  })
  const dropCommandFinishedStatusIfSameTurn = (
    entry: AgentStatusEntry | undefined,
    options?: { allowInferredInterrupt?: boolean }
  ): void => {
    const state = useAppStore.getState()
    if (!entry) {
      // Why: an Orca-started agent can exit before its first hook status. The
      // launch registry was still created up front, so clear it on command exit.
      state.clearAgentLaunchConfig(cacheKey)
      return
    }
    const current = state.agentStatusByPaneKey[cacheKey]
    if (!current) {
      state.clearAgentLaunchConfig(cacheKey)
      return
    }
    const unchanged =
      current.state === entry.state &&
      current.prompt === entry.prompt &&
      current.updatedAt === entry.updatedAt &&
      current.stateStartedAt === entry.stateStartedAt &&
      current.agentType === entry.agentType
    const inferredFromEntry =
      options?.allowInferredInterrupt === true &&
      current.state === 'done' &&
      current.interrupted === true &&
      current.prompt === entry.prompt &&
      current.agentType === entry.agentType &&
      current.stateHistory?.some(
        (history) =>
          history.state === entry.state &&
          history.prompt === entry.prompt &&
          history.startedAt === entry.stateStartedAt
      ) === true
    if (!unchanged && !inferredFromEntry) {
      return
    }
    state.dropAgentStatus(cacheKey)
  }
  let pendingTerminalInputIntent: AgentInterruptInputIntent | null = null
  let clearPendingTerminalInputIntentTimer: ReturnType<typeof setTimeout> | null = null
  const clearPendingTerminalInputIntent = (): void => {
    pendingTerminalInputIntent = null
    if (clearPendingTerminalInputIntentTimer !== null) {
      clearTimeout(clearPendingTerminalInputIntentTimer)
      clearPendingTerminalInputIntentTimer = null
    }
  }
  const setPendingTerminalInputIntent = (intent: AgentInterruptInputIntent): void => {
    clearPendingTerminalInputIntent()
    pendingTerminalInputIntent = intent
    clearPendingTerminalInputIntentTimer = setTimeout(() => {
      clearPendingTerminalInputIntent()
    }, 0)
  }
  const inputMatchesIntent = (intent: AgentInterruptInputIntent, data: string): boolean => {
    return (
      (intent === 'plain-escape' && data === '\x1b') || (intent === 'ctrl-c' && data === '\x03')
    )
  }
  const inferIntentFromExactTerminalInput = (data: string): AgentInterruptInputIntent | null => {
    if (data === '\x03') {
      return 'ctrl-c'
    }
    if (data === '\x1b') {
      return 'plain-escape'
    }
    return null
  }
  const observeSentTerminalInputIntent = (
    data: string,
    intent = pendingTerminalInputIntent
  ): void => {
    if (intent && inputMatchesIntent(intent, data)) {
      interruptInference.observeInputIntent(intent)
      observeTitleOnlyInterrupt()
    }
  }
  const observeAcceptedTerminalInput = (
    data: string,
    intent: AgentInterruptInputIntent | null = null
  ): void => {
    if (intent === 'ctrl-c' || data === '\x03') {
      markTerminalBracketedPasteInterrupted(pane.terminal)
    }
    // Why: every delivered-input path funnels through here, so this is where a
    // submit keystroke into a waiting AskUserQuestion pane becomes the
    // "question answered" signal no hook will ever deliver.
    questionAnsweredInference.observeSentTerminalInput(data)
  }
  let pendingTerminalInputWrite: Promise<void> | null = null
  const setPendingTerminalInputWrite = (promise: Promise<void>): void => {
    pendingTerminalInputWrite = promise
    void promise.finally(() => {
      if (pendingTerminalInputWrite === promise) {
        pendingTerminalInputWrite = null
      }
    })
  }
  const flushPendingInterruptInference = (): boolean | Promise<boolean> => {
    const pendingWrite = pendingTerminalInputWrite
    if (!pendingWrite) {
      return interruptInference.flushPending()
    }
    return pendingWrite.then(() => interruptInference.flushPending())
  }
  // Why: the 133;D confirmation guard and the visible-pane resampler both key off
  // "does this pane expect an agent"; derive each signal once so the two callers
  // can't drift and silently reintroduce the icon bug this fix closes.
  const paneHasLiveHookAgentIcon = (state: ReturnType<typeof useAppStore.getState>): boolean => {
    const entry = state.agentStatusByPaneKey[cacheKey]
    return entry?.state !== 'done' && Boolean(agentTypeToIconAgent(entry?.agentType))
  }
  const paneExpectsLaunchAgent = (state: ReturnType<typeof useAppStore.getState>): boolean => {
    const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find(
      (candidate) => candidate.id === deps.tabId
    )
    const registeredLaunchAgent = state.agentLaunchConfigByPaneKey[cacheKey]?.identity.agentType
    return Boolean(
      tab?.launchAgent ??
      paneStartup?.launchAgent ??
      paneStartup?.initialAgentStatus?.agent ??
      (isTuiAgent(registeredLaunchAgent) ? registeredLaunchAgent : undefined)
    )
  }
  // Why: the concrete TUI agent a fresh spawn is expected to launch, used to seed
  // a command-start confirmation on no-OSC shells (Git Bash/cmd) that never emit
  // one. Returns null when the expectation isn't a recognized TUI agent.
  const resolveExpectedLaunchTuiAgent = (): TuiAgent | null => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find(
      (candidate) => candidate.id === deps.tabId
    )
    const candidate =
      tab?.launchAgent ??
      paneStartup?.launchAgent ??
      paneStartup?.initialAgentStatus?.agent ??
      state.agentLaunchConfigByPaneKey[cacheKey]?.identity.agentType
    return isTuiAgent(candidate) ? candidate : null
  }
  // Why: a launched/hook-known agent pane must confirm — not trust — a 133;D so a
  // full-screen agent's leaked nested-shell 133;D can't clear its tab identity,
  // even on a restore where no command-start read has recorded evidence yet.
  const paneHasKnownAgentIdentity = (): boolean => {
    const state = useAppStore.getState()
    const registeredLaunchAgent = state.agentLaunchConfigByPaneKey[cacheKey]?.identity.agentType
    return (
      Boolean(state.paneForegroundAgentByPaneKey[cacheKey]?.agent) ||
      paneHasLiveHookAgentIcon(state) ||
      isTuiAgent(registeredLaunchAgent)
    )
  }
  // Why: a plain `codex`/`grok` sets its OSC title and the shell never repaints
  // it on exit, so a confirmed return-to-shell must clear a title that still
  // names an agent — otherwise the tab reads "grok" over a bare prompt. Only
  // reset an agent-named title; user/shell-set titles are left untouched.
  const clearStaleAgentTabTitleOnConfirmedShell = (): void => {
    const state = useAppStore.getState()
    const currentTitle = state.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
    const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find(
      (entry) => entry.id === deps.tabId
    )
    const title = currentTitle ?? tab?.title
    if (!title || resolveCommittedTitleAgentType(title) === null) {
      return
    }
    const neutralTitle = neutralTerminalTitle()
    deps.setRuntimePaneTitle(deps.tabId, pane.id, neutralTitle)
    if (manager.getActivePane()?.id === pane.id) {
      deps.updateTabTitle(deps.tabId, neutralTitle)
    }
  }
  let deferredCommandFinishedStatusDrop: (() => void) | null = null
  let visibleForegroundSamplePending = false
  let visibleForegroundSampleSettled = false
  const settleDeferredCommandFinishedStatusDrop = (): void => {
    const dropStatus = deferredCommandFinishedStatusDrop
    deferredCommandFinishedStatusDrop = null
    dropStatus?.()
  }
  const isForegroundTrackingAllowed = (id: string): boolean => {
    if (isRemoteRuntimePtyId(id) || parseAppSshPtyId(id) !== null) {
      return false
    }
    if (!navigator.userAgent.includes('Windows')) {
      return true
    }
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find(
      (candidate) => candidate.id === deps.tabId
    )
    // Why: WSL and remote-runtime panes can never authorize native ConPTY
    // bytes, so do not pay for Windows process scans that cannot affect routing.
    return isLocalNativeWindowsConpty({
      userAgent: navigator.userAgent,
      connectionId: getConnectionId(deps.worktreeId) ?? null,
      cwd: deps.cwd,
      shellOverride: tab?.shellOverride,
      executionHostId: getExecutionHostIdForWorktree(state, deps.worktreeId)
    })
  }
  const paneForegroundAgentTracker = createPaneForegroundAgentTracker({
    getPtyId: () => transport.getPtyId(),
    isTrackablePtyId: isForegroundTrackingAllowed,
    readForegroundProcess: (id) => window.api.pty.getForegroundProcess(id),
    confirmForegroundProcess: (id) => window.api.pty.confirmForegroundProcess(id),
    publish: (entry) => useAppStore.getState().setPaneForegroundAgent(cacheKey, entry),
    hasKnownAgentIdentity: paneHasKnownAgentIdentity,
    onConfirmedShellForeground: (reason) => {
      clearStaleAgentTabTitleOnConfirmedShell()
      if (reason === 'visible-pty') {
        useAppStore.getState().clearAgentLaunchConfig(cacheKey)
        return
      }
      settleDeferredCommandFinishedStatusDrop()
    },
    onCommandFinishedUnavailable: settleDeferredCommandFinishedStatusDrop,
    onVisibleForegroundSettled: (outcome) => {
      visibleForegroundSamplePending = false
      visibleForegroundSampleSettled = outcome !== 'inconclusive'
    }
  })
  // Why: one command-finished policy whether the signal arrives as bytes
  // (remote PTYs, kill switch off) or as a main-derived pty:sideEffect fact —
  // routing both through this handler keeps the drop/interrupt semantics
  // identical across authority modes.
  const handleCommandFinished = (_bestEffortExitCode: number | null): void => {
    clearCommandInferredPaneAgentAfterPtySideEffects()
    visibleForegroundSamplePending = false
    const shouldDeferStatusDrop = paneForegroundAgentTracker.onCommandFinished()
    // Why: the finished command may have moved HEAD or the index (e.g.
    // `git checkout`); nudge git UI now instead of waiting for a poll.
    dispatchTerminalCommandFinishedEvent(deps.worktreeId)
    const state = useAppStore.getState()
    const entry = state.agentStatusByPaneKey[cacheKey]
    const inferenceResult = flushPendingInterruptInference()
    const dropStatus = (): void => {
      if (inferenceResult === true) {
        dropCommandFinishedStatusIfSameTurn(entry, { allowInferredInterrupt: true })
        return
      }
      if (inferenceResult instanceof Promise) {
        void inferenceResult.then((applied) => {
          dropCommandFinishedStatusIfSameTurn(entry, {
            allowInferredInterrupt: applied === true
          })
        })
        return
      }
      dropCommandFinishedStatusIfSameTurn(entry)
    }
    if (shouldDeferStatusDrop) {
      // Why: keep the concrete pane identity routable while the local process
      // check distinguishes a leaked nested-shell D from a genuine agent exit.
      deferredCommandFinishedStatusDrop = dropStatus
      return
    }
    deferredCommandFinishedStatusDrop = null
    dropStatus()
  }
  const sampleVisiblePaneForegroundAgent = (forceRoutingConfirmation = false): void => {
    if (
      !deps.isVisibleRef.current ||
      visibleForegroundSamplePending ||
      visibleForegroundSampleSettled
    ) {
      return
    }
    const state = useAppStore.getState()
    const foreground = state.paneForegroundAgentByPaneKey[cacheKey]
    // Why: a daemon reattach may restore display identity without current
    // routing authority. Only fresh evidence can suppress its confirmation.
    if (foreground?.agent && foreground.routingTrusted === true) {
      return
    }
    if (!forceRoutingConfirmation && paneHasLiveHookAgentIcon(state)) {
      return
    }
    const expectsAgent = paneExpectsLaunchAgent(state)
    // Why: a completed local process ladder is stronger than stale tab/startup
    // launch metadata. Command-start clears this mark if the pane becomes busy.
    if (foreground?.shellForeground) {
      return
    }
    // Why: tab launch metadata can leak across split panes; rebuild pane-scoped
    // identity from local process state, with remote/SSH excluded by the tracker.
    visibleForegroundSamplePending = paneForegroundAgentTracker.onVisiblePtyBound(expectsAgent)
  }
  startAcceptedInferredCommand = (agent) => {
    paneForegroundAgentTracker.onCommandStarted(agent)
  }
  requestKnownDroidReconfirmation = () => {
    const foreground = useAppStore.getState().paneForegroundAgentByPaneKey[cacheKey]
    // Why: daemon reattach/launch metadata is display-only until a live
    // provider read confirms it. Submit/interrupt/title-exit evidence must
    // revoke that launch-only hint too, otherwise Shift+Enter can route bytes
    // to a Droid that already exited before confirmation ever ran.
    if (foreground?.agent !== 'droid') {
      return
    }
    // Why: cmd.exe and Git Bash have no OSC command boundaries. Keep the icon
    // as a hint, but revoke bytes until one current provider confirmation lands.
    useAppStore.getState().setPaneForegroundAgent(cacheKey, {
      agent: 'droid',
      shellForeground: false
    })
    visibleForegroundSamplePending = false
    visibleForegroundSampleSettled = false
    // Why: hook rows can suppress display-only sampling, but cannot restore
    // byte authority after this function explicitly revoked routing trust.
    sampleVisiblePaneForegroundAgent(true)
  }
  const commandLifecycle = createTerminalCommandLifecycle({
    onCommandStarted: () => {
      // Why: a new command invalidates cleanup waiting on the previous D; only
      // a later confirmed shell boundary may retire this pane's live identity.
      deferredCommandFinishedStatusDrop = null
      visibleForegroundSamplePending = false
      visibleForegroundSampleSettled = false
      // Why: typed commands can be aliases, so they only widen the bounded
      // process-confirmation window; they never become routing evidence.
      paneForegroundAgentTracker.onCommandStarted(commandInferredPaneAgent)
    },
    onCommandFinished: handleCommandFinished
  })
  // Why: the xterm OSC 133 swallow is rendering hygiene, not a side effect —
  // it stays attached in every authority mode.
  commandLifecycle.attachXtermConsumer(pane.terminal)
  const onTerminalKeyDown = (event: KeyboardEvent): void => {
    if (isPlainEscapeKeyEvent(event)) {
      setPendingTerminalInputIntent('plain-escape')
      // Why: plain Escape produces real terminal input (\x1b), so it is a
      // genuine "user is here" signal and must still dismiss attention before
      // the early return for interrupt-intent inference.
      deps.clearTerminalTabUnread(deps.tabId)
      deps.clearTerminalPaneUnread(cacheKey)
      deps.clearWorktreeUnread(deps.worktreeId)
      return
    }
    if (isCtrlCKeyEvent(event)) {
      if (!navigator.userAgent.includes('Mac') && pane.terminal.hasSelection()) {
        return
      }
      setPendingTerminalInputIntent('ctrl-c')
    }
    // Why: only treat keydowns that will produce real terminal input as the
    // "user is here" signal. Modifier-only presses, autorepeat, and Cmd/Ctrl+C
    // copy chords with an active selection must not dismiss attention on a
    // sibling pane before the user has seen it.
    if (
      event.repeat ||
      event.key === 'Alt' ||
      event.key === 'AltGraph' ||
      event.key === 'Control' ||
      event.key === 'Meta' ||
      event.key === 'Shift'
    ) {
      return
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'c' &&
      pane.terminal.hasSelection()
    ) {
      return
    }
    // Why: user shell frameworks (bash-preexec/iTerm2) can replace Orca's
    // OSC 133;C hook, so a manually launched agent produces no command-start
    // signal at all. Enter at a shell-foreground prompt is the user-side
    // equivalent; the sample is gated to panes with no live agent identity
    // and publishes nothing for an idle shell.
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      sampleVisiblePaneForegroundAgent()
    }
    deps.clearTerminalTabUnread(deps.tabId)
    deps.clearTerminalPaneUnread(cacheKey)
    deps.clearWorktreeUnread(deps.worktreeId)
  }
  // Why: infer only from focused xterm key events. Raw PTY bytes cannot
  // distinguish plain Escape from Alt/meta sequences, and programmatic writes
  // should not clear agent status.
  const terminalKeyTarget = pane.terminal.element ?? pane.container
  const terminalKeyTargetSupportsEvents =
    typeof terminalKeyTarget?.addEventListener === 'function' &&
    typeof terminalKeyTarget?.removeEventListener === 'function'
  if (terminalKeyTargetSupportsEvents) {
    terminalKeyTarget.addEventListener('keydown', onTerminalKeyDown, { capture: true })
  }

  const setPanePtyFitBinding = (ptyId: string): void => {
    bindPanePtyId(pane.id, ptyId, deps.tabId)
    pane.container.dataset.ptyId = ptyId
    // Why: override hydration can arrive before this pane knows its PTY. Once
    // data-pty-id is bound, safeFit can park xterm at the held phone grid.
    if (getFitOverrideForPty(ptyId)) {
      safeFit(pane)
    }
  }
  let activePanePtyBinding: string | null = null
  // Why: bind time lets async liveness reconcile ignore a request started
  // before this PTY bound (newborn race). Null disables the guard (fail-safe).
  let activePanePtyBindingBoundAt: number | null = null

  // Why: with main side-effect authority on, the pane's title/bell/agent
  // policy callbacks consume pty:sideEffect facts instead of transport byte
  // parsers (which stay unregistered) — same policy code, single consumer.
  // restoreTitleOnRegister replaces the eager-replay title restore: main's
  // title-only snapshot carries the no-attention-replay rule.
  let unregisterSideEffectFactConsumer: (() => void) | null = null
  const registerSideEffectFactConsumerForPty = (ptyId: string): void => {
    if (!mainSideEffectAuthority || disposed) {
      return
    }
    unregisterSideEffectFactConsumer?.()
    unregisterSideEffectFactConsumer = registerTerminalSideEffectFactConsumer({
      ptyId,
      callbacks: {
        onTitleChange,
        onBell,
        onAgentBecameIdle,
        onAgentBecameWorking,
        onAgentExited,
        onCommandFinished: handleCommandFinished,
        onPrLink: (link) =>
          useAppStore.getState().observeTerminalGitHubPullRequestLink(deps.worktreeId, link),
        // Why: the Command Code settle policy stays here — the done settle
        // timer must consult the live store row (which hook events and
        // renderer seeds also write), so main only emits scrape facts.
        onCommandCodeWorking: seedCommandCodeOutputWorkingStatus,
        onCommandCodeDone: scheduleCommandCodeOutputDoneStatus,
        // Why: gated hidden panes never see the subscribe bytes; the fact
        // replaces the byte scan (and the old post-latch subscribe drop).
        ...(hiddenDeliveryGateActive
          ? { onMode2031Subscribe: handleHiddenMode2031SubscribeFact }
          : {})
      },
      restoreTitleOnRegister: true
    })
  }
  const dropSideEffectFactConsumer = (): void => {
    unregisterSideEffectFactConsumer?.()
    unregisterSideEffectFactConsumer = null
  }
  const clearPanePtyFitBinding = (): void => {
    // Why: fit bindings live in a module-level map, so pane teardown must
    // clear them explicitly instead of relying on DOM removal.
    bindPanePtyId(pane.id, null, deps.tabId)
    activePanePtyBinding = null
    activePanePtyBindingBoundAt = null
    delete pane.container.dataset.ptyId
  }

  const agentCompletionCoordinator = createAgentCompletionCoordinator({
    paneKey: cacheKey,
    getPtyId: () => transport.getPtyId(),
    getSettings: () => useAppStore.getState().settings,
    inspectProcess: inspectRuntimeTerminalProcess,
    dispatchHookLifecycle: (payload) => dispatchAgentHookTerminalLifecycle(cacheKey, payload),
    shouldSuppressProcessReplacementCompletion: (_exited, replacement) => {
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[cacheKey]
      const currentAgentForReplacement = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        replacement.agent
      )
      return (
        isFreshNonDoneAgentStatus(currentStatus) && currentAgentForReplacement === replacement.agent
      )
    },
    shouldSuppressConfirmedProcessExitCompletion: (exited) => {
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[cacheKey]
      const currentAgentForExited = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        exited.agent
      )
      // Why: a replacement hook can lead process visibility by one cadence;
      // only a different known active owner can veto confirmed old-process exit.
      return Boolean(
        isFreshNonDoneAgentStatus(currentStatus) &&
        currentStatus.agentType &&
        currentStatus.agentType !== 'unknown' &&
        currentAgentForExited !== exited.agent
      )
    },
    dispatchCompletion: (title, meta) => {
      if (meta?.source === 'process-exit') {
        clearSuppressedTitleSideEffects()
      }
      if (meta?.terminalIdleConfirmed === true) {
        // Why: an agent can crash before its done hook; confirmed process death
        // must still restore cursor and native Windows Kitty keyboard modes.
        const currentAgentStatus = useAppStore.getState().agentStatusByPaneKey[cacheKey]
        if (!isFreshNonDoneAgentStatus(currentAgentStatus)) {
          setFocusReportSuppressionForAgentCompletion(title, meta.agentStatus?.agentType)
        }
        queueAgentIdleTerminalModeReset()
      }
      scheduleAgentTaskCompleteNotification(title, {
        allowDoneDetailAfterGrace: meta?.quietedHookDone,
        ...(meta?.source === 'process-exit' ? { agentCompletionSource: meta.source } : {}),
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      })
    },
    dispatchAttention: (title, meta) =>
      scheduleAgentTaskCompleteNotification(title, {
        agentStatusSnapshot: meta.agentStatus
      }),
    shouldPollProcessCadence: () =>
      isAgentTaskCompleteTrackingEnabled() && deps.isVisibleRef.current,
    isProcessInspectionCostly: () => {
      // Why: local Windows inspection forks a powershell.exe whole-process-table
      // CIM scan per poll (~10-40x heavier than POSIX `ps`); SSH/remote PTYs run
      // their scans on the remote host, so only local Windows panes relax the
      // no-evidence cadence.
      if (!navigator.userAgent.includes('Windows')) {
        return false
      }
      const ptyId = transport.getPtyId()
      return ptyId !== null && !isRemoteRuntimePtyId(ptyId) && parseAppSshPtyId(ptyId) === null
    },
    isLive: () => {
      if (disposed) {
        return false
      }
      if (transport.getPtyId()) {
        return true
      }
      return (useAppStore.getState().ptyIdsByTabId[deps.tabId] ?? []).length > 0
    },
    shouldSuppressHookCompletion: createCodexAutoApprovalHookCompletionSuppressor(cacheKey, () => ({
      tabId: deps.tabId,
      ...(launchToken ? { launchToken } : {})
    }))
  })

  const focusSurvivingPtyPaneAfterKeptExit = (): void => {
    if (manager.getActivePane()?.id !== pane.id) {
      return
    }
    const hasPtyBinding = (paneId: number): boolean =>
      Boolean(deps.paneTransportsRef.current.get(paneId)?.getPtyId())
    const repairedActiveLeafId =
      useAppStore.getState().terminalLayoutsByTabId[deps.tabId]?.activeLeafId ?? null
    const repairedActivePaneId = repairedActiveLeafId
      ? manager.getNumericIdForLeaf(repairedActiveLeafId)
      : null
    const targetPaneId =
      repairedActivePaneId !== null &&
      repairedActivePaneId !== pane.id &&
      hasPtyBinding(repairedActivePaneId)
        ? repairedActivePaneId
        : (manager
            .getPanes()
            .find((candidate) => candidate.id !== pane.id && hasPtyBinding(candidate.id))?.id ??
          null)
    if (targetPaneId !== null) {
      // Why: when a newborn split PTY dies before output/input, the pane stays
      // mounted for diagnostics; move live focus to the sibling that still owns a PTY.
      manager.setActivePane(targetPaneId, {
        focus: deps.isActiveRef.current && deps.isVisibleRef.current
      })
    }
  }

  // Why: the transport's own exit handler (pty-transport.ts) normally makes
  // onExit run-at-most-once by clearing connected/ptyId + unregistering BEFORE
  // calling it. reconcileIfSessionDead drives onExit directly (bypassing that),
  // so this guards the body so reconcile and any racing real/synthetic pty:exit
  // for the same id close the pane exactly once. Scoped to the exiting ptyId
  // (not a bare boolean): an intentional suppressed restart keeps the pane
  // mounted and rebinds to a NEW ptyId, and that replacement's later real exit
  // must still run — a one-shot boolean would strand the pane on rebind.
  let handledExitPtyId: string | null = null
  // Why: tracks the ptyId of a genuine fresh spawn — onPtySpawn fires only for
  // fresh spawns, never reattach/coldRestore (pty-transport.ts). Lets the
  // sole-pane exit branch tell "this newborn shell died on its own" from "a
  // reattached persisted session was already dead", so a failing .envrc/direnv
  // on a brand-new worktree keeps its dead terminal visible instead of bouncing
  // the user to Landing.
  let spawnedFreshPtyId: string | null = null
  // Why: hibernation suppresses its kill's exit while the pane is hidden, so
  // onExit must not tear the pane down — but the pane still owes the user a
  // wake. Remember the hibernated PTY and exact record; the visibility-resume
  // hook consumes both and cannot accidentally adopt a later stale record.
  type HibernatedWakeTarget = { ptyId: string; record: SleepingAgentSessionRecord }
  let hibernatedWakeTarget: HibernatedWakeTarget | null = null
  let wakeHibernatedAgentPane: (() => Promise<string | null>) | null = null
  // Why: a mobile wake can land after the sleeping record is written but
  // before the suppressed kill exit arms the wake target. The phone never
  // reveals the desktop pane, so without a latch the edge-triggered wake would
  // be dropped and the phone left on a frozen terminal.
  let pendingHibernatedWakeTarget: HibernatedWakeTarget | null = null
  // Why: transport.connect settles asynchronously. Repeated mobile activation
  // must keep claiming this provider session until the replacement PTY either
  // exists (and clears the sleep record) or the spawn fails and can be retried.
  let hibernatedWakeInFlightClaimKey: string | null = null
  // Why: reveal is the normal wake trigger, but a reveal that lands *during* the
  // in-flight hibernation kill runs noteVisibilityResume before onExit arms the
  // wake. Sharing the guarded consume lets both the reveal hook and the
  // arm-time foreground check resume the pane exactly once.
  const consumeHibernatedAgentWake = (claimedProviderSessions?: Set<string>): string | null => {
    const target = hibernatedWakeTarget
    if (!target || disposed) {
      return null
    }
    if (deps.paneTransportsRef.current.get(pane.id) !== transport) {
      return null
    }
    const currentRecord = getSleepingRecordForPane(useAppStore.getState())?.record
    if (currentRecord !== target.record) {
      hibernatedWakeTarget = null
      pendingHibernatedWakeTarget = null
      return null
    }
    const currentPtyId = transport.getPtyId()
    // Why: a real pty:exit clears the transport's ptyId before onExit while a
    // reconcile-driven exit leaves it bound; both mean "nothing respawned since
    // hibernation". A different non-null id means another flow (e.g. an
    // intentional restart) already rebound the pane — its spawn wins.
    if (currentPtyId !== null && currentPtyId !== target.ptyId) {
      hibernatedWakeTarget = null
      pendingHibernatedWakeTarget = null
      return null
    }
    if (!wakeHibernatedAgentPane) {
      return null
    }
    const claimKey = getProviderSessionClaimKey(target.record)
    if (claimedProviderSessions?.has(claimKey)) {
      return null
    }
    // Why: one wake event can visit multiple mounted legacy/stable panes for
    // the same provider session. Claim synchronously before any spawn starts.
    claimedProviderSessions?.add(claimKey)
    hibernatedWakeTarget = null
    pendingHibernatedWakeTarget = null
    hibernatedWakeInFlightClaimKey = claimKey
    // Why: reveal is the wake signal for a hibernated pane. Resume the recorded
    // agent session (or fall back to a fresh shell) instead of leaving the
    // frozen frame with no PTY behind it.
    void wakeHibernatedAgentPane()
      .then((spawnedPtyId) => {
        if (!spawnedPtyId) {
          // Why: a transient replacement-spawn failure leaves the passive
          // record owned by this pane. Re-arm the exact target so a later
          // mobile open can retry instead of stranding the frozen session;
          // consume revalidates disposal, binding, PTY, and record identity.
          hibernatedWakeTarget = target
        }
      })
      .finally(() => {
        if (hibernatedWakeInFlightClaimKey === claimKey) {
          hibernatedWakeInFlightClaimKey = null
        }
      })
    return claimKey
  }
  const onExit = (ptyId: string): void => {
    if (handledExitPtyId === ptyId) {
      return
    }
    resetRendererOrderedSeqForPtyExit(ptyId)
    const currentPaneTransport = deps.paneTransportsRef.current.get(pane.id)
    if (currentPaneTransport && currentPaneTransport !== transport) {
      // Why: an old transport can deliver a late exit after this pane has
      // rebound to a replacement PTY; only clear ownership for the exited id.
      handledExitPtyId = ptyId
      deps.clearTabPtyId(deps.tabId, ptyId)
      deps.consumeSuppressedPtyExit(ptyId)
      scheduleRuntimeGraphSync()
      return
    }
    handledExitPtyId = ptyId
    agentCompletionCoordinator.dispose()
    dropSideEffectFactConsumer()
    // Why: main clears gate state on PTY exit too; this only resets the
    // pane-local marker so a reused pane cannot skip re-marking a new PTY.
    releaseHiddenRendererPtyDelivery()
    clearPanePtyFitBinding()
    // Why: the negotiating application died with its PTY; any replacement
    // session starts with kitty keyboard flags at zero.
    kittyKeyboardModes.reset()
    const isSuppressedExit = deps.consumeSuppressedPtyExit(ptyId)
    if (!isSuppressedExit) {
      deps.clearExitedPanePtyLayoutBinding(pane.id, ptyId)
    }
    deps.clearRuntimePaneTitle(deps.tabId, pane.id)
    deps.clearTabPtyId(deps.tabId, ptyId)
    // Why: if the PTY exits abruptly (Ctrl-D, crash, shell termination) without
    // first emitting a non-agent title, the cache timer would persist as stale
    // state. Clear it unconditionally on PTY exit.
    deps.setCacheTimerStartedAt(cacheKey, null)
    // Why: a dead terminal has no running agent — remove its explicit status
    // entry so the hover UI only shows what is running *now*.
    useAppStore.getState().removeAgentStatus(cacheKey)
    useAppStore.getState().clearPaneForegroundAgent(cacheKey)
    // The runtime graph is the CLI's source for live terminal bindings, so
    // we must republish when a pane loses its PTY instead of waiting for a
    // broader layout change that may never happen.
    scheduleRuntimeGraphSync()
    // Why: intentional restarts suppress the PTY exit ahead of time so the
    // pane stays mounted and can reconnect in place. Without consuming the
    // suppression here, split-pane Codex restarts would still close the pane
    // because this handler runs before the tab-level close logic sees the exit.
    if (isSuppressedExit) {
      // Why: the action that suppressed the exit owns whether the leaf binding
      // is a wake hint or should be discarded; runtime cleanup above is enough.
      manager.setPaneGpuRendering(pane.id, true)
      const sleepingRecordEntry = getSleepingRecordForPane(useAppStore.getState())
      if (
        sleepingRecordEntry &&
        isPassiveCompletedHibernationEvidence(sleepingRecordEntry.record)
      ) {
        // Why: hibernation killed this pane's PTY while hidden. The frozen TUI
        // frame still has mouse-tracking/bracketed-paste armed, which silently
        // eats every click and keystroke against a dead transport — disarm the
        // modes now and arm the reveal-time wake.
        replayIntoTerminal(pane, deps.replayingPanesRef, POST_REPLAY_MODE_RESET, {
          shouldRefreshViewportSynchronously: shouldRefreshForegroundSynchronously
        })
        hibernatedWakeTarget = { ptyId, record: sleepingRecordEntry.record }
        const pendingWakeMatches =
          pendingHibernatedWakeTarget?.ptyId === ptyId &&
          pendingHibernatedWakeTarget.record === sleepingRecordEntry.record
        if (pendingHibernatedWakeTarget && !pendingWakeMatches) {
          pendingHibernatedWakeTarget = null
        }
        if (deps.isVisibleRef.current || pendingWakeMatches) {
          // Why: a reveal (or a mobile wake) that raced this kill already ran
          // before the exit landed, so it saw nothing armed. Consume the wake
          // now (deferred off the exit handler) so the pane still resumes
          // without needing a second hide/reveal or wake event.
          queueMicrotask(() => {
            consumeHibernatedAgentWake()
          })
        }
      } else if (pendingHibernatedWakeTarget?.ptyId === ptyId) {
        pendingHibernatedWakeTarget = null
      }
      return
    }
    manager.setPaneGpuRendering(pane.id, true)
    const panes = manager.getPanes()
    if (panes.length <= 1) {
      // Why: a worktree's sole newborn terminal can die on shell startup — e.g.
      // a PR branch ships an .envrc whose direnv command fails, so the login
      // shell exits non-zero immediately. Routing that through onPtyExitRef
      // closes the only tab, which deactivates the worktree (setActiveWorktree
      // (null)) and strands the user on the Landing screen for a worktree that
      // was just created. Keep the dead pane mounted instead (mirrors the
      // freshly-split guard below) so the direnv error stays visible and the
      // worktree stays active. Gated on a genuine fresh spawn (onPtySpawn fired
      // for this ptyId — reattach/coldRestore skip it) that the user never typed
      // into, so a reattached-dead session or an explicit `exit` still tears
      // down as before.
      if (spawnedFreshPtyId === ptyId && !Number.isFinite(lastTerminalInputAt)) {
        return
      }
      deps.onPtyExitRef.current(ptyId)
      return
    }
    if (
      deps.isVisibleRef.current &&
      hadExistingPaneTransportAtConnect &&
      !restoredPtyIdForTransport &&
      !Number.isFinite(lastTerminalInputAt) &&
      !hasReceivedPtyOutput
    ) {
      // Why: a freshly split pane can lose its newborn PTY during setup; keep
      // the split visible so the failed session does not immediately collapse.
      // Hidden panes must close instead: the hidden-delivery gate withholds
      // their bytes, so "no output" is meaningless there, and keeping one
      // strands a binding-less pane the exit path never revisits — it remounts
      // as a permanently blank ghost on reveal.
      focusSurvivingPtyPaneAfterKeptExit()
      return
    }
    manager.closePane(pane.id)
  }

  // Why: on app restart, restored Claude tabs may already be idle when we first
  // see their title. The agent status tracker only fires onBecameIdle for
  // working→idle transitions, so the cache timer would never start for these
  // sessions. We only allow this one-time seed for reattached PTYs; fresh
  // Claude launches also start idle, but they have no prompt cache yet.
  let hasConsideredInitialCacheTimerSeed = false
  let allowInitialIdleCacheSeed = false

  const resolveCurrentAgentStatusRouting = () => {
    const ptyId = activePanePtyBinding ?? transport.getPtyId()
    const state = useAppStore.getState()
    if (disposed || !ptyId) {
      return undefined
    }
    return resolveLiveAgentStatusConnectionRouting({
      state,
      paneKey: cacheKey,
      ptyId,
      expectedConnectionId: worktreeConnectionId,
      runtimeEnvironmentId: transport.getRuntimeEnvironmentId?.() ?? runtimeEnvironmentId
    })
  }

  const onTitleChange = (
    title: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ): void => {
    // Why: one owner-aware decision drives the display label, the runtime/tab
    // title, task-completion tracking, and the renderer gate, so raw title text
    // can no longer disable GPU behind stronger owner evidence (#7428/#7447).
    const decision = resolvePaneTitleDecision({
      normalizedTitle: title,
      rawTitle,
      displayOwnerAgentType: getAuthoritativePaneAgent(),
      rendererOwnerAgentType: getPaneScopedRendererOwner(),
      userGpuMode: useAppStore.getState().settings?.terminalGpuAcceleration ?? 'auto'
    })
    const paneTitle = decision.displayTitle
    if (
      shouldSuppressCodexAutoApprovalSyntheticTitle(paneTitle, {
        paneKey: cacheKey,
        tabId: deps.tabId,
        ...(launchToken ? { launchToken } : {})
      })
    ) {
      return
    }
    manager.setPaneGpuRendering(pane.id, decision.rendererPolicy.gpuEnabled)
    deps.setRuntimePaneTitle(deps.tabId, pane.id, paneTitle)
    // Why: a stale-derived cleared title comes from main's unthrottled 3s
    // timer, not agent output. It must update the visible title but never
    // feed completion tracking — observeTitle would classify the cleared
    // title as idle and mint a task-complete for a merely-paused agent.
    if (!meta?.staleWorkingTitleClear && syncAgentTaskCompleteTrackingEnabled()) {
      const activeHookStatus = useAppStore.getState().agentStatusByPaneKey[cacheKey]
      if (!shouldSuppressTitleCompletionForFreshHook(decision.rawTitle, activeHookStatus)) {
        // Why: display titles still update while hooks are active, but a stale
        // idle frame must not complete the coordinator turn before hook `done`.
        agentCompletionCoordinator.observeTitle(decision.rawTitle)
      }
    }
    // Why: only the focused pane should drive the tab title — otherwise two
    // agents in split panes cause rapid title flickering as each emits OSC
    // sequences. Only the active split's title propagates to the tab. When
    // focus changes, onActivePaneChange syncs the newly active pane's stored
    // title to the tab.
    if (manager.getActivePane()?.id === pane.id) {
      deps.updateTabTitle(deps.tabId, paneTitle)
    }

    if (!hasConsideredInitialCacheTimerSeed) {
      hasConsideredInitialCacheTimerSeed = true
      const state = useAppStore.getState()
      if (
        shouldSeedCacheTimerOnInitialTitle({
          rawTitle,
          allowInitialIdleSeed: allowInitialIdleCacheSeed,
          existingTimerStartedAt: state.cacheTimerByKey[cacheKey],
          promptCacheTimerEnabled: state.settings?.promptCacheTimerEnabled ?? null
        })
      ) {
        deps.setCacheTimerStartedAt(cacheKey, Date.now())
      }
    }
  }

  const applyInitialAgentStatus = (terminalTitle?: string): void => {
    const initialStatus = paneStartup?.initialAgentStatus
    const routing = resolveCurrentAgentStatusRouting()
    if (!initialStatus || !routing) {
      return
    }
    const statusPayload = {
      state: 'working' as const,
      prompt: initialStatus.prompt,
      agentType: resolveCompatibleAgentTypeForOwner(
        initialStatus.agent,
        getAuthoritativePaneAgent()
      )
    }
    if (paneStartup.launchConfig) {
      useAppStore
        .getState()
        .setAgentStatus(cacheKey, statusPayload, terminalTitle, undefined, routing, {
          launchConfig: paneStartup.launchConfig,
          ...(launchToken ? { launchToken } : {})
        })
      return
    }
    useAppStore
      .getState()
      .setAgentStatus(cacheKey, statusPayload, terminalTitle, undefined, routing)
  }

  const seedCommandCodeOutputWorkingStatus = (prompt: string): void => {
    clearCommandCodeOutputDoneTimer()
    const routing = resolveCurrentAgentStatusRouting()
    if (!routing) {
      return
    }
    const currentState = useAppStore.getState()
    const currentEntry = currentState.agentStatusByPaneKey[cacheKey]
    const currentTitle = currentState.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
    const normalizedPrompt = prompt.trim()
    if (
      currentEntry?.agentType === 'command-code' &&
      currentEntry.state === 'done' &&
      (!normalizedPrompt || normalizedPrompt === currentEntry.prompt.trim())
    ) {
      return
    }
    currentState.setAgentStatus(
      cacheKey,
      {
        state: 'working',
        prompt: normalizedPrompt || (currentEntry?.state === 'working' ? currentEntry.prompt : ''),
        agentType: 'command-code'
      },
      currentTitle,
      undefined,
      routing
    )
  }

  let commandCodeOutputDoneTimer: ReturnType<typeof setTimeout> | null = null
  const clearCommandCodeOutputDoneTimer = (): void => {
    if (commandCodeOutputDoneTimer !== null) {
      clearTimeout(commandCodeOutputDoneTimer)
      commandCodeOutputDoneTimer = null
    }
  }
  const scheduleCommandCodeOutputDoneStatus = (prompt: string): void => {
    clearCommandCodeOutputDoneTimer()
    const normalizedPrompt = prompt.trim()
    if (!normalizedPrompt) {
      return
    }
    // Why: Command Code keeps rendering the composer while tools run. Only
    // complete the row if no active status repaint arrives during this window.
    commandCodeOutputDoneTimer = setTimeout(() => {
      commandCodeOutputDoneTimer = null
      if (disposed) {
        return
      }
      const currentState = useAppStore.getState()
      const routing = resolveCurrentAgentStatusRouting()
      if (!routing) {
        return
      }
      const currentEntry = currentState.agentStatusByPaneKey[cacheKey]
      if (currentEntry?.agentType !== 'command-code' || currentEntry.state !== 'working') {
        return
      }
      const currentPrompt = currentEntry.prompt.trim()
      if (currentPrompt && currentPrompt !== normalizedPrompt) {
        return
      }
      const currentTitle = currentState.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
      currentState.setAgentStatus(
        cacheKey,
        {
          state: 'done',
          prompt: currentPrompt || normalizedPrompt,
          agentType: 'command-code'
        },
        currentTitle,
        undefined,
        routing
      )
    }, COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)
  }

  const observeTerminalGitHubPRLink = createTerminalGitHubPRLinkDetector()
  const reportPanePtyVisibility = (ptyId: string | null | undefined, visible: boolean): void => {
    if (!ptyId || isRemoteRuntimePtyId(ptyId)) {
      // Why: remote-runtime PTYs use a relay path outside main's local
      // renderer-visibility registry, so reporting them here is misleading.
      return
    }
    setRendererPtyVisibilityClaim(transport, ptyId, visible)
  }
  const bindActivePanePty = (
    ptyId: string,
    options: {
      seedInitialAgentStatus?: boolean
      updateTabPtyId?: 'always' | 'if-missing'
      replacePtyId?: string
      sampleVisibleForegroundAgent?: boolean
    } = {}
  ): void => {
    if (activePanePtyBinding && activePanePtyBinding !== ptyId) {
      reportPanePtyVisibility(activePanePtyBinding, false)
    }
    setPanePtyFitBinding(ptyId)
    activePanePtyBinding = ptyId
    reportPanePtyVisibility(ptyId, deps.isVisibleRef.current)
    // Why: record bind time on the spawn/attach chokepoint so the reconcile
    // guard knows this binding is newer than any pre-bind snapshot.
    activePanePtyBindingBoundAt = performance.now()
    registerSideEffectFactConsumerForPty(ptyId)
    syncHiddenRendererPtyDelivery()
    deps.syncPanePtyLayoutBinding(pane.id, ptyId)
    const tabPtyIds = useAppStore.getState().ptyIdsByTabId?.[deps.tabId] ?? []
    if (options.updateTabPtyId !== 'if-missing' || !tabPtyIds.includes(ptyId)) {
      if (options.replacePtyId) {
        deps.updateTabPtyId(deps.tabId, ptyId, options.replacePtyId)
      } else {
        deps.updateTabPtyId(deps.tabId, ptyId)
      }
    }
    if (options.seedInitialAgentStatus) {
      applyInitialAgentStatus()
    }
    // Spawn/attach completion is when a pane gains a concrete PTY ID. The initial
    // frame-level sync often runs before that async result arrives.
    scheduleRuntimeGraphSync()
    agentCompletionCoordinator.startProcessTracking()
    // Why: fresh spawns normally rely on a future OSC 133 command-start read to
    // identify the launched agent; only adopted or restored PTYs may already be
    // inside Codex with no new foreground signal. But no-OSC shells (Git Bash,
    // cmd.exe) never emit a command-start, so an expected-agent pane spawned into
    // one would never gain the fresh process evidence that authorizes Droid's
    // Windows Shift+Enter CSI-u routing — leaving Shift+Enter to submit (#7620).
    // Seed the SAME command-start confirmation the manually-typed launch path
    // uses (onCommandStarted): its bounded retry ladder spans agent boot, and a
    // miss publishes shellForeground:false — recoverable by later focus/reveal
    // samples. A visible-pty sample would instead let a slow boot latch a
    // known-agent shell-confirm that clears launch identity and blocks recovery.
    // A real OSC 133;C, if it arrives, simply supersedes this.
    if (options.sampleVisibleForegroundAgent === true) {
      sampleVisiblePaneForegroundAgent()
    } else if (options.seedInitialAgentStatus === true) {
      const freshSpawnLaunchAgent = resolveExpectedLaunchTuiAgent()
      if (freshSpawnLaunchAgent) {
        paneForegroundAgentTracker.onCommandStarted(freshSpawnLaunchAgent)
      }
    }
  }

  const onPtySpawn = (ptyId: string): void => {
    // Why: record that this exact PTY was freshly spawned (not reattached), so a
    // newborn shell that dies before any interaction (e.g. failing direnv on a
    // just-created worktree) can be kept visible rather than tearing down the
    // worktree. Reattach/coldRestore skip onPtySpawn (pty-transport.ts).
    spawnedFreshPtyId = ptyId
    // Why: Command Code has no prompt-start hook. Seed the visible working row
    // once the PTY exists, then let real hook events refine or complete it.
    bindActivePanePty(ptyId, { seedInitialAgentStatus: true })
  }
  const onPtyRebind = (ptyId: string, replacedPtyId: string): void => {
    // Why: provider handle rotation keeps the existing pane/session generation;
    // replace its stale store identity without fresh-spawn exit semantics.
    bindActivePanePty(ptyId, { replacePtyId: replacedPtyId })
  }
  // ─── Attention signal: BEL ────────────────────────────────────────────
  //
  // BEL (0x07) is the attention signal. A BEL raises tab- and worktree-level
  // indicators, and fires an OS notification. The experimental pane marker
  // clears when the user interacts with the exact pane.
  //
  // The one case where BEL falsely fires is when a crashed TUI left DEC
  // private mode 1004 (focus event reporting) enabled — pane clicks then
  // emit `\e[I`/`\e[O` into the shell, zsh treats them as unbound keys and
  // rings the bell. This is specific to terminals with cross-restart
  // persistence (as we have); our fix is to reset 1004 and friends after
  // scrollback replay so the mode state matches the fresh shell
  // underneath. See POST_REPLAY_MODE_RESET in layout-serialization.ts.
  const onBell = (): void => {
    // Why: restored Claude Code sessions have been observed to emit a real
    // standalone BEL some time after daemon snapshot reattach, even when Orca
    // did not just forward focus/control input. Treat the BEL as authoritative
    // PTY output here; any product-side suppression should be an explicit UX
    // decision higher up, not a transport-layer guess.
    deps.markWorktreeUnread(deps.worktreeId)
    deps.markTerminalTabUnread(deps.tabId)
    if (useAppStore.getState().settings?.experimentalTerminalAttention === true) {
      deps.markTerminalPaneUnread(cacheKey)
    }
    // Why: agent CLIs often emit BEL in the same completion burst as their
    // working->idle title change. Delay only the OS notification so the richer
    // agent-complete notification can win the main-process worktree cooldown.
    pendingTerminalBellNotification = true
    if (!hasPendingAgentTaskCompleteNotification()) {
      scheduleTerminalBellNotification()
    }
  }

  const clearTerminalBellNotificationTimer = (): void => {
    if (terminalBellNotificationTimer !== null) {
      clearTimeout(terminalBellNotificationTimer)
      terminalBellNotificationTimer = null
    }
  }

  const scheduleTerminalBellNotification = (): void => {
    if (terminalBellNotificationTimer !== null) {
      return
    }
    terminalBellNotificationTimer = setTimeout(() => {
      terminalBellNotificationTimer = null
      if (disposed) {
        pendingTerminalBellNotification = false
        return
      }
      if (hasPendingAgentTaskCompleteNotification()) {
        return
      }
      pendingTerminalBellNotification = false
      deps.dispatchNotification({ source: 'terminal-bell', paneKey: cacheKey })
    }, AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
  }

  const hasPendingAgentTaskCompleteNotification = (): boolean =>
    isAgentTaskCompleteNotificationEnabled() &&
    (agentCompletionCoordinator.hasPendingHookDoneCompletion() ||
      agentTaskCompleteNotificationGraceTimer !== null ||
      agentTaskCompleteNotificationMaxTimer !== null ||
      agentTaskCompleteStatusUnsubscribe !== null)

  const clearPendingAgentTaskCompleteNotification = (): void => {
    if (agentTaskCompleteNotificationGraceTimer !== null) {
      clearTimeout(agentTaskCompleteNotificationGraceTimer)
      agentTaskCompleteNotificationGraceTimer = null
    }
    if (agentTaskCompleteNotificationMaxTimer !== null) {
      clearTimeout(agentTaskCompleteNotificationMaxTimer)
      agentTaskCompleteNotificationMaxTimer = null
    }
    if (agentTaskCompleteStatusUnsubscribe !== null) {
      agentTaskCompleteStatusUnsubscribe()
      agentTaskCompleteStatusUnsubscribe = null
    }
  }

  const syncAgentTaskCompleteTrackingEnabled = (): boolean => {
    const enabled = isAgentTaskCompleteTrackingEnabled()
    const osNotificationsEnabled = isAgentTaskCompleteNotificationEnabled()
    if (
      !osNotificationsEnabled &&
      wasAgentTaskCompleteOsNotificationEnabled &&
      pendingTerminalBellNotification
    ) {
      scheduleTerminalBellNotification()
    }
    if (!enabled && wasAgentTaskCompleteTrackingEnabled) {
      // Why: disabling every completion consumer is an event-time boundary.
      // Drop pending alerts while preserving accepted-hook lifecycle state.
      agentTaskCompleteNotificationGeneration += 1
      requiresFreshWorkingForAgentTaskCompleteNotification = true
      clearPendingAgentTaskCompleteNotification()
      if (pendingTerminalBellNotification) {
        scheduleTerminalBellNotification()
      }
    } else if (enabled && !wasAgentTaskCompleteTrackingEnabled) {
      // Why: a pane may have observed work while all completion consumers were
      // disabled. Re-enabling should not let the next idle event report old work.
      requiresFreshWorkingForAgentTaskCompleteNotification = true
    }
    wasAgentTaskCompleteTrackingEnabled = enabled
    wasAgentTaskCompleteOsNotificationEnabled = osNotificationsEnabled
    return enabled
  }

  const scheduleAgentTaskCompleteNotification = (
    title: string,
    options: {
      allowDoneDetailAfterGrace?: boolean
      agentStatusSnapshot?: AgentCompletionStatusSnapshot
      agentCompletionSource?: AgentCompletionDispatchMeta['source']
    } = {}
  ): void => {
    if (
      !syncAgentTaskCompleteTrackingEnabled() ||
      requiresFreshWorkingForAgentTaskCompleteNotification
    ) {
      return
    }
    clearPendingAgentTaskCompleteNotification()
    let graceElapsed = false
    const generationAtSchedule = agentTaskCompleteNotificationGeneration
    const agentStatusAtSchedule = useAppStore.getState().agentStatusByPaneKey[cacheKey]
    const hasNewerActiveHookStatus = (): boolean => {
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[cacheKey]
      const scheduledAgentType = agentStatusAtSchedule?.agentType
      const currentAgentForScheduledTurn = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        scheduledAgentType
      )
      const hasDifferentKnownAgent = Boolean(
        currentStatus?.agentType &&
        scheduledAgentType &&
        currentStatus.agentType !== 'unknown' &&
        scheduledAgentType !== 'unknown' &&
        currentAgentForScheduledTurn !== scheduledAgentType
      )
      return (
        options.agentCompletionSource === 'process-exit' &&
        isFreshNonDoneAgentStatus(currentStatus) &&
        (!agentStatusAtSchedule ||
          currentStatus.state !== agentStatusAtSchedule.state ||
          currentStatus.stateStartedAt !== agentStatusAtSchedule.stateStartedAt ||
          hasDifferentKnownAgent)
      )
    }

    const dispatch = (): void => {
      clearPendingAgentTaskCompleteNotification()
      if (
        generationAtSchedule !== agentTaskCompleteNotificationGeneration ||
        !syncAgentTaskCompleteTrackingEnabled() ||
        hasNewerActiveHookStatus()
      ) {
        return
      }
      if (disposed) {
        return
      }
      // Why: terminal attention is a visual pane affordance, not an OS
      // notification. Route through dispatch so stale pane completions are
      // rejected before unread attention is marked.
      const shouldDispatchOsNotification = isAgentTaskCompleteNotificationEnabled()
      pendingTerminalBellNotification = false
      clearTerminalBellNotificationTimer()
      deps.dispatchNotification({
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey: cacheKey,
        ...(options.agentCompletionSource
          ? { agentCompletionSource: options.agentCompletionSource }
          : {}),
        ...(shouldDispatchOsNotification ? {} : { suppressOsNotification: true }),
        ...(options.agentStatusSnapshot ? { agentStatusSnapshot: options.agentStatusSnapshot } : {})
      })
    }

    const dispatchIfDetailed = (): void => {
      if (hasNewerActiveHookStatus()) {
        // Why: the confirmed exit belongs to the row captured above; a replaced
        // active row means a newer turn started during the notification delay.
        clearPendingAgentTaskCompleteNotification()
        return
      }
      if (!graceElapsed) {
        return
      }
      const entry = useAppStore.getState().agentStatusByPaneKey[cacheKey]
      if (canDispatchAgentNotificationAfterGrace(entry, options)) {
        dispatch()
      }
    }

    agentTaskCompleteStatusUnsubscribe = useAppStore.subscribe(dispatchIfDetailed)
    agentTaskCompleteNotificationGraceTimer = setTimeout(() => {
      agentTaskCompleteNotificationGraceTimer = null
      graceElapsed = true
      dispatchIfDetailed()
    }, AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    // Why: some agents never surface assistant text through hooks. Keep a hard
    // cap so task-complete notifications still fire instead of waiting forever.
    agentTaskCompleteNotificationMaxTimer = setTimeout(
      dispatch,
      AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS
    )
  }
  agentTaskCompleteSettingsUnsubscribe = subscribeAgentTaskCompleteTrackingEnabled(() => {
    if (syncAgentTaskCompleteTrackingEnabled()) {
      agentCompletionCoordinator.startProcessTracking()
    }
  })

  // ─── Agent task-complete: notification-backed attention ───────────────
  //
  // The working→idle title transition drives two independent concerns:
  //   1. The Claude prompt-cache countdown in the sidebar.
  //   2. The "Agent Task Complete" OS notification users toggle in Settings.
  //
  // This path raises the same terminal attention marker as BEL through the
  // shared notification dispatcher. Not every agent CLI reliably emits BEL on
  // completion (Gemini, some Codex flows), and the highlight needs to remain
  // findable after the OS banner is gone. Double-firing with a concurrent BEL
  // is handled by delaying the BEL OS notification below; main still keeps a
  // 5 s per-worktree dedupe as the final guard.
  const onAgentBecameIdle = (title: string, meta?: { staleWorkingTitleClear?: boolean }): void => {
    // Why: a stale-derived idle comes from main's UNTHROTTLED 3s timer, not
    // observed bytes — a merely-paused agent (>3s silent mid-task, window
    // minimized) would otherwise mint a false task-complete OS notification
    // that renderer timer throttling previously damped. Clear session-tied
    // state only; never schedule completion attention from it.
    if (meta?.staleWorkingTitleClear) {
      deps.setCacheTimerStartedAt(cacheKey, null)
      return
    }
    const currentState = useAppStore.getState()
    const activeHookStatus = currentState.agentStatusByPaneKey[cacheKey]
    if (shouldSuppressTitleCompletionForFreshHook(title, activeHookStatus)) {
      // Why: agent CLIs can briefly publish an idle title while hook status
      // still says the same agent turn is active (e.g. during tool output).
      if (activeHookStatus) {
        preserveSuppressedTitleSideEffects(title, activeHookStatus)
      }
      return
    }
    // Why: only start the prompt-cache countdown for Claude agents — other
    // agents have different (or no) prompt-caching semantics and showing a
    // timer for them would be misleading.
    //
    // Why we check `settings !== null` separately: during startup, settings
    // hydrate asynchronously after terminals reconnect. If we treat null
    // as disabled, the first working→idle transition on a restored Claude
    // tab silently drops the timer. Writing a timestamp is cheap and the
    // CacheTimer component gates rendering on the enabled flag, so a
    // spurious write when the feature turns out to be disabled is harmless.
    const settings = currentState.settings
    if (isClaudeAgent(title) && (settings === null || settings.promptCacheTimerEnabled)) {
      deps.setCacheTimerStartedAt(cacheKey, Date.now())
    }
    if (detectAgentStatusFromTitle(title) === 'idle') {
      setFocusReportSuppressionForAgentCompletion(title, activeHookStatus?.agentType)
    }
    if (syncAgentTaskCompleteTrackingEnabled()) {
      agentCompletionCoordinator.observeClassifiedTitleCompletion(title)
    }
    // Why: some agent TUIs leave xterm renderer modes active after a turn.
    // Reset cursor everywhere, and Kitty keyboard state on native Windows.
    queueAgentIdleTerminalModeReset()
  }
  const onAgentBecameWorking = (): void => {
    suppressNativeWindowsIdleCodexFocusReports = false
    clearSuppressedTitleSideEffects()
    if (syncAgentTaskCompleteTrackingEnabled()) {
      requiresFreshWorkingForAgentTaskCompleteNotification = false
      agentCompletionCoordinator.observeTitleWorking()
    }
    // Why: a new API call refreshes the prompt-cache TTL, so clear any running
    // countdown. The timer will restart when the agent becomes idle again.
    deps.setCacheTimerStartedAt(cacheKey, null)
    clearPendingAgentTaskCompleteNotification()
    if (pendingTerminalBellNotification) {
      scheduleTerminalBellNotification()
    }
  }
  const onAgentExited = (): void => {
    // Why: eligibility can disappear transiently during reconnect, but a
    // confirmed shell-title transition is authoritative for native-chat exit.
    deps.onAgentExitedRef.current(pane.leafId)
    clearSuppressedTitleSideEffects()
    clearCommandInferredPaneAgent()
    requestKnownDroidReconfirmation()
    // Why: when the terminal title reverts to a plain shell (e.g., "bash", "zsh"),
    // the agent has exited. Clear any running cache timer so the sidebar doesn't
    // show a stale countdown for a tab that no longer has an active Claude session.
    deps.setCacheTimerStartedAt(cacheKey, null)
    clearTitleOnlyInterruptTimer()
    // Why: title reversion alone is not process death. The process/PTY tracker
    // owns removing agent rows when the TUI actually exits.
  }
  // Why: inject ORCA_PANE_KEY so global Claude/Codex hooks can attribute their
  // callbacks to the correct Orca pane without resolving worktrees from cwd.
  // The key matches the `${tabId}:${leafId}` composite used for cacheTimerByKey
  // and agentStatusByPaneKey. Treat it as opaque outside Orca.
  const state = useAppStore.getState()
  const parsedWorkspaceKey = parseWorkspaceKey(deps.worktreeId)
  const folderWorkspace =
    parsedWorkspaceKey?.type === 'folder'
      ? state.folderWorkspaces.find(
          (workspace) => workspace.id === parsedWorkspaceKey.folderWorkspaceId
        )
      : null
  const workspaceEnv: Record<string, string> = { ORCA_WORKSPACE_ID: deps.worktreeId }
  if (folderWorkspace) {
    workspaceEnv.ORCA_PROJECT_GROUP_ID = folderWorkspace.projectGroupId
    workspaceEnv.ORCA_WORKSPACE_ROOT = folderWorkspace.folderPath
  }
  const paneIdentityEnv = {
    ...workspaceEnv,
    ORCA_PANE_KEY: cacheKey,
    ORCA_TAB_ID: deps.tabId,
    ORCA_WORKTREE_ID: deps.worktreeId,
    ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
  }
  const paneEnv = {
    ...paneStartup?.env,
    ...paneIdentityEnv
  }

  // Why: folder workspaces can inherit their SSH target from child repos, so
  // use the shared resolver instead of only looking up repo-backed worktrees.
  const worktree = getWorktreeMapFromState(state).get(deps.worktreeId)
  const worktreeConnectionId = getConnectionId(deps.worktreeId)
  const connectionId = worktreeConnectionId ?? null
  const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find((t) => t.id === deps.tabId)
  const shellOverride = tab?.shellOverride
  // Why: a serve/remote-runtime pane has no SSH connectionId and a Linux cwd, so
  // the native-Windows ConPTY heuristic misfires on a Windows client and wrongly
  // enables ConPTY synchronized-output protection, which strips an agent's
  // transient cursor-show (?25h) and leaves the cursor invisible. The execution
  // host is the authoritative signal: only a 'local' host is a local native PTY.
  const executionHostId = getExecutionHostIdForWorktree(state, deps.worktreeId)
  const isNativeWindowsConpty = isLocalNativeWindowsConpty({
    userAgent: navigator.userAgent,
    connectionId,
    cwd: deps.cwd,
    // Why: main folds the global Windows shell into its spawn classification
    // (pty.ts effectiveShellOverride); fold it here too so both sides treat
    // a global-WSL default identically (terminal-query-authority.md ConPTY).
    shellOverride: resolveWindowsShellOverride(shellOverride, state.settings?.terminalWindowsShell),
    executionHostId
  })
  if (isNativeWindowsConpty) {
    // Why: Windows ConPTY agent turns can leave renderer keyboard modes armed
    // after completion, corrupting plain input with encoded bytes.
    idleAgentTerminalModeReset = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`
  }
  const shouldApplyNativeWindowsRewriteRefresh = isNativeWindowsConpty
  const shouldApplyWindowsRendererUnicodeRefresh = CLIENT_PLATFORM === 'win32'
  const shouldProtectNativeWindowsSynchronizedOutput = isNativeWindowsConpty
  let lastAgentStatusState = state.agentStatusByPaneKey[cacheKey]?.state
  let unsubscribeWindowsDoneTerminalModeReset: (() => void) | null = null
  if (isNativeWindowsConpty) {
    const initialAgentStatus = state.agentStatusByPaneKey[cacheKey]
    if (
      !initialAgentStatus &&
      paneStartup?.telemetry?.launch_source === 'sidebar' &&
      paneStartup.telemetry.request_kind === 'resume' &&
      (paneStartup.launchAgent === 'codex' || paneStartup.telemetry.agent_kind === 'codex')
    ) {
      // Why: history resumes open on a completed Codex composer without a done
      // row, so arm the same Windows stale-focus guard until work starts again.
      suppressNativeWindowsIdleCodexFocusReports = true
    }
    if (initialAgentStatus?.state === 'done') {
      setFocusReportSuppressionForAgentCompletion(undefined, initialAgentStatus.agentType)
    }
    unsubscribeWindowsDoneTerminalModeReset = useAppStore.subscribe((nextState) => {
      const nextAgentStatus = nextState.agentStatusByPaneKey[cacheKey]
      const nextAgentStatusState = nextAgentStatus?.state
      if (nextAgentStatusState === 'done') {
        setFocusReportSuppressionForAgentCompletion(undefined, nextAgentStatus.agentType)
        if (lastAgentStatusState !== 'done') {
          queueAgentIdleTerminalModeReset()
        }
      } else if (nextAgentStatusState) {
        suppressNativeWindowsIdleCodexFocusReports = false
      }
      lastAgentStatusState = nextAgentStatusState
    })
  }

  const restoredPtyIdForTransport =
    deps.restoredLeafId && deps.restoredPtyIdByLeafId
      ? (deps.restoredPtyIdByLeafId[deps.restoredLeafId] ?? null)
      : null
  const remoteRuntimeOwnerForTransport =
    (restoredPtyIdForTransport
      ? getRemoteRuntimePtyEnvironmentId(restoredPtyIdForTransport)
      : null) ?? (tab?.ptyId ? getRemoteRuntimePtyEnvironmentId(tab.ptyId) : null)
  const runtimeEnvironmentId =
    remoteRuntimeOwnerForTransport ?? getRuntimeEnvironmentIdForWorktree(state, deps.worktreeId)
  const localWindowsTerminalCapabilities = hasCachedWindowsTerminalCapabilities()
    ? getCachedWindowsTerminalCapabilities()
    : null
  const projectRuntime =
    !connectionId && runtimeEnvironmentId === null
      ? getLocalProjectExecutionRuntimeContext(state, deps.worktreeId, undefined, {
          wslAvailable: localWindowsTerminalCapabilities?.wslAvailable,
          availableWslDistros: localWindowsTerminalCapabilities?.wslDistros ?? null
        })
      : undefined
  const shouldOwnAgentStatusInRenderer = runtimeEnvironmentId !== null
  // Why: when main holds side-effect authority for this PTY's bytes, the
  // transport must NOT register title/bell/agent byte parsers — the
  // pty:sideEffect fact consumer below is the single policy consumer.
  // Decided once at transport creation so a fact never has two consumers.
  const mainSideEffectAuthority = isMainTerminalSideEffectAuthorityForPty({
    settings: state.settings,
    runtimeEnvironmentId
  })
  // Why: Phase-4 hidden-delivery gate — only meaningful under main authority
  // (renderer byte parsers need bytes otherwise). Decided once at pane
  // creation: it picks the mode-2031 answer path (fact reply vs byte scan),
  // which must have exactly one owner.
  const hiddenDeliveryGateActive =
    mainSideEffectAuthority && isRendererHiddenPtyDeliveryGateEnabled(state.settings)
  // Why: structural per-PTY gate predicate (authority on + gate on + bytes
  // transit local main, which implies snapshot-backed). Shared by the hidden
  // mark sync and mode-2031 reply ownership so reply ownership can never
  // disagree with what main may drop — and never depends on the racy hidden
  // mark (a fact can outrun the pty:data task that sets it).
  const isHiddenDeliveryGateManagedPty = (ptyId: string | null): ptyId is string =>
    hiddenDeliveryGateActive && Boolean(ptyId) && !isRemoteRuntimePtyId(ptyId)
  // Why (byte-parser mode only): with main authority the Command Code scrape
  // runs in main's per-PTY tracker and arrives as command-code facts; running
  // the byte detector too would double-drive the seed/settle policy above.
  const commandCodeOutputStatusDetector = mainSideEffectAuthority
    ? null
    : createCommandCodeOutputStatusDetector({
        startupCommand: paneStartup?.command,
        onWorking: seedCommandCodeOutputWorkingStatus,
        onDone: scheduleCommandCodeOutputDoneStatus
      })
  const shouldDeliverStartupViaTerminalPaste = paneStartup?.delivery === 'terminal-paste'
  const hadExistingPaneTransportAtConnect = deps.paneTransportsRef.current.size > 0
  let lastTerminalInputAt = Number.NEGATIVE_INFINITY
  let hasReceivedPtyOutput = false
  let deferredReattachLiveData:
    | { data: string; ptyId: string | null; streamGeneration: number; meta?: PtyDataMeta }[]
    | null = null
  let deferredReattachLiveDataChars = 0
  let reattachLiveDataDeferralDepth = 0
  let deferredReattachLiveDataOwners = new Map<number, { failed: boolean }>()
  let transportStreamGeneration = 0
  const MAX_DEFERRED_REATTACH_LIVE_CHARS = 512 * 1024
  const MAX_DEFERRED_REATTACH_LIVE_CHUNKS = 1_024
  const markTerminalInputSent = (): void => {
    lastTerminalInputAt = performance.now()
  }
  const recordTerminalInputForHibernation = (): void => {
    useAppStore.getState().recordTerminalInput(cacheKey)
  }
  // Why: onData mixes real user input with xterm's parser auto-replies (focus
  // reports, DA/DSR/CPR responses). Recording those replies as activity makes
  // the hibernation planner treat a pane hidden after its agent finished as
  // "input after done" forever. The core user-input signal fires only for real
  // input, so hibernation activity records from it; onData recording remains
  // solely as the fallback when the internal API is unavailable.
  const userInputActivityDisposable = subscribeToTerminalUserInput(
    pane.terminal,
    recordTerminalInputForHibernation
  )
  const recordTerminalInputForHibernationFallback = (): void => {
    if (userInputActivityDisposable === null) {
      recordTerminalInputForHibernation()
    }
  }
  const markAcceptedTerminalInputSent = (): void => {
    markTerminalInputSent()
    recordTerminalInputForHibernationFallback()
  }
  const terminalTheme = pane.terminal.options.theme
  const terminalColorQueryReplies = terminalTheme
    ? { foreground: terminalTheme.foreground, background: terminalTheme.background }
    : undefined
  const transportOptions = {
    cwd: deps.cwd,
    // Why: only fresh local IPC spawns may recover from a saved startup cwd
    // whose directory was deleted (#7239); remote-runtime and SSH spawns
    // resolve cwd on another host and must keep exact cwd semantics.
    ...(runtimeEnvironmentId === null && !connectionId ? { cwdFallback: 'worktree' as const } : {}),
    env: paneEnv,
    command: shouldDeliverStartupViaTerminalPaste ? undefined : paneStartup?.command,
    startupCommandDelivery: shouldDeliverStartupViaTerminalPaste
      ? undefined
      : paneStartup?.startupCommandDelivery,
    connectionId,
    worktreeId: deps.worktreeId,
    // Why: closes the SIGKILL race documented in INVESTIGATION.md by letting
    // main sync-flush the (worktreeId, tabId, leafId → ptyId) binding before
    // pty:spawn returns. Daemon-host-only: SSH path leaves these undefined
    // and the main-side guard short-circuits.
    tabId: deps.tabId,
    leafId: pane.leafId,
    activate: deps.isActiveRef.current && deps.isVisibleRef.current,
    ...(shellOverride ? { shellOverride } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
    ...(paneStartup?.launchConfig ? { launchConfig: paneStartup.launchConfig } : {}),
    ...(launchToken ? { launchToken } : {}),
    ...(paneStartup?.launchAgent ? { launchAgent: paneStartup.launchAgent } : {}),
    ...(paneStartup?.telemetry ? { telemetry: paneStartup.telemetry } : {}),
    onPtyExit: onExit,
    onPtySpawn,
    onPtyRebind,
    ...(mainSideEffectAuthority
      ? {}
      : {
          onTitleChange,
          onBell,
          onAgentBecameIdle,
          onAgentBecameWorking,
          onAgentExited
        }),
    // Why: local IPC terminals are now model-owned in main: OrcaRuntimeService
    // parses OSC 9999 before renderer delivery and forwards through the hook
    // server with local/SSH identity. Remote-runtime streams do not pass through
    // local main, so the renderer remains their status owner for now.
    ...(shouldOwnAgentStatusInRenderer
      ? {
          onAgentStatus: (payload) => {
            if (
              shouldSuppressCodexAutoApprovalStatus(payload, {
                paneKey: cacheKey,
                tabId: deps.tabId,
                ...(launchToken ? { launchToken } : {})
              })
            ) {
              return
            }
            // Why: capture the store snapshot once so the title lookup and the
            // setAgentStatus call observe the same state. Re-reading getState()
            // between the two lines opens a brief window where the title could
            // shift (OSC title update landing in between) and the status would
            // be stored against a title that was never paired with it.
            const currentState = useAppStore.getState()
            const routing = resolveCurrentAgentStatusRouting()
            if (!routing) {
              return
            }
            const title = currentState.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
            const authoritativePaneAgent = getAuthoritativePaneAgent()
            const agentType = resolveCompatibleAgentTypeForOwner(
              payload.agentType,
              authoritativePaneAgent
            )
            const statusPayload =
              agentType === payload.agentType ? payload : { ...payload, agentType }
            const resolvedStatusTitle = resolveAgentStatusTerminalTitle(statusPayload, title)
            const statusTitle = resolvedStatusTitle
              ? normalizeCompatibleAgentTitleForOwner(
                  resolvedStatusTitle,
                  agentType ?? authoritativePaneAgent
                )
              : resolvedStatusTitle
            if (launchToken) {
              currentState.setAgentStatus(
                cacheKey,
                statusPayload,
                statusTitle,
                undefined,
                routing,
                {
                  launchToken
                }
              )
            } else {
              currentState.setAgentStatus(cacheKey, statusPayload, statusTitle, undefined, routing)
            }
            const trackingEnabled = syncAgentTaskCompleteTrackingEnabled()
            if (payload.state === 'working' && trackingEnabled) {
              requiresFreshWorkingForAgentTaskCompleteNotification = false
            }
            const storedStatus = useAppStore.getState().agentStatusByPaneKey[cacheKey]
            const notificationPayload =
              typeof storedStatus?.stateStartedAt === 'number'
                ? { ...statusPayload, stateStartedAt: storedStatus.stateStartedAt }
                : statusPayload
            // Why: hook lifecycle owns deferred terminal side effects even when
            // every outward completion alert consumer is disabled.
            agentCompletionCoordinator.observeHookStatus(notificationPayload)
            if (payload.state === 'working' && pendingTerminalBellNotification) {
              scheduleTerminalBellNotification()
            }
          }
        }
      : {})
  }
  const transport = runtimeEnvironmentId
    ? createRemoteRuntimePtyTransport(runtimeEnvironmentId, transportOptions)
    : createIpcPtyTransport(transportOptions)
  const canSendDesktopQueryReply = (): boolean => {
    const ptyId = transport.getPtyId()
    return !ptyId || !isPtyLocked(ptyId)
  }
  // Why: parser/capability handlers bypass the ordinary onData guard. Keep
  // desktop silent while the elected mobile xterm owns query replies.
  const sendDesktopQueryReplyImmediate = (data: string): boolean =>
    canSendDesktopQueryReply() && transport.sendInputImmediate(data)
  // Why (gate mode only): for gate-managed PTYs this fact is the SOLE 2031
  // responder — visible, hidden, marked or not. Conditioning the reply on the
  // hidden mark double-fired (mark set + bytes delivered live via interest →
  // fact AND xterm both replied) or dropped the reply entirely (fact outran
  // the pty:data task that set the mark). The xterm-side CSI reply and the
  // skipped-byte scan are disabled for these panes (same structural
  // predicate), so exactly one reply goes out.
  const handleHiddenMode2031SubscribeFact = (): void => {
    if (disposed || !isHiddenDeliveryGateManagedPty(transport.getPtyId())) {
      return
    }
    const mode = resolveTerminalColorSchemeMode(
      useAppStore.getState().settings,
      getSystemPrefersDark()
    )
    // Why immediate: a mode-2031 query reply must beat the remote input debounce
    // or it can miss the querying program's read window (#7329).
    sendDesktopQueryReplyImmediate(mode2031SequenceFor(mode))
    // Why: register the subscription exactly like the xterm CSI handler
    // would — without the registry entry, later theme flips never push the
    // CSI 997 update and the TUI keeps a stale theme after reveal.
    deps.recordPaneMode2031Subscription?.(pane.id, mode)
    recordHiddenMode2031Reply()
  }
  deps.paneTransportsRef.current.set(pane.id, transport)
  const terminalCapabilityRepliesDisposable = installTerminalCapabilityReplyHandlers({
    terminal: pane.terminal,
    parser: pane.terminal.parser,
    // Why: OSC 10/11 + DA1 replies must beat the querying program's raw-mode
    // read window; the remote transport's input debounce would corrupt them
    // (#7329), so send immediately.
    sendInput: sendDesktopQueryReplyImmediate,
    isReplaying: () => isPaneReplaying(deps.replayingPanesRef, pane.id),
    ...(isNativeWindowsConpty ? { da1Response: CONPTY_DA1_RESPONSE } : {})
  })
  const respondToTerminalPixelSizeQueries = createTerminalPixelSizeQueryResponder(
    pane.terminal,
    sendDesktopQueryReplyImmediate
  )

  const claimViewportForUserActivity = (): void => {
    const currentPtyId = transport.getPtyId()
    if (!currentPtyId || getFitOverrideForPty(currentPtyId)?.mode !== 'remote-desktop-fit') {
      return
    }
    let proposed: { cols: number; rows: number } | undefined
    try {
      proposed = pane.fitAddon.proposeDimensions()
    } catch {
      proposed = undefined
    }
    const cols = proposed?.cols ?? pane.terminal.cols
    const rows = proposed?.rows ?? pane.terminal.rows
    if (cols > 0 && rows > 0) {
      // Why: queuing a claim is not convergence. Keep the pane parked until the
      // runtime confirms desktop-fit so a transient resize failure retries.
      transport.claimViewport?.(cols, rows)
    }
  }

  // Why: an unbound transport (detached during a remount/move and never
  // rebound) silently rejects every keystroke while the PTY stays alive and
  // the last frame stays painted — the pane looks healthy and eats input
  // (issue #8104 class). None of the dead-session reconciles cover it because
  // the PTY is live; recover by remounting the tab over the live PTY.
  let transportConnectInFlightSince: number | null = null
  // Why a grace window instead of a plain flag: a connect that never settles
  // (SSH RPC timeout class, wedged daemon call) would otherwise suppress
  // input-triggered recovery FOREVER — and such a pane has no output flowing,
  // so no other detector can fire. Past the grace, undeliverable input may
  // recover again; the transport's destroyed-check no longer kills a
  // pre-existing session when a late reattach resolves, so a remount racing
  // a slow-but-alive connect costs a wasted view rebuild, not a shell.
  const TRANSPORT_CONNECT_SETTLE_GRACE_MS = 60_000
  const requestRecoveryForUndeliverableInput = (): void => {
    if (transport.isConnected?.() && transport.getPtyId() !== null) {
      return
    }
    // Why: input rejected while a connect/reattach is still settling is "not
    // deliverable YET", not a dead binding. Remounting here destroys the
    // unbound transport, and pty-transport's destroyed check then kills the
    // PTY the in-flight reattach resolves to — the live shell recovery exists
    // to preserve. The fossil case this detector targets has no pending
    // connect, so it still recovers. Same for a late async reject landing
    // after dispose: the successor pane owns the tab now.
    const connectStillSettling =
      transportConnectInFlightSince !== null &&
      Date.now() - transportConnectInFlightSince < TRANSPORT_CONNECT_SETTLE_GRACE_MS
    if (connectStillSettling || disposed) {
      return
    }
    const storePtyId = useAppStore.getState().ptyIdsByTabId?.[deps.tabId]?.[0] ?? null
    const undeliverablePtyId = transport.getPtyId() ?? storePtyId
    void requestTerminalPaneRecovery({
      tabId: deps.tabId,
      ptyId: undeliverablePtyId,
      reason: 'input-undeliverable',
      terminalRecoveryGeneration,
      terminalRecoveryInstanceId: terminalRecoveryInstance.id,
      // Why: pty:hasPty answers null for ids the local registry doesn't own,
      // and a disconnected remote pane would otherwise remount-churn on every
      // cooldown window while typing. Local panes keep the lenient gate.
      requireAuthoritativeLiveness:
        Boolean(transport.getConnectionId?.()) || isRemoteRuntimePtyId(undeliverablePtyId)
    })
  }
  // Why: the write-pipeline health watch (scheduler stall probe, replay-guard
  // wedge certification) detects a dead xterm pipeline; route its verdict to
  // the same tab remount. Registered per xterm instance — recovery replaces
  // the instance, which resets certification naturally.
  const unregisterUndeliverableWriteHandler = registerUndeliverableWriteHandler(
    pane.terminal,
    (reason) => {
      // Certification can arrive while this terminal still owns queued or
      // detached scheduler work; release its delivery credits immediately.
      discardTerminalOutput(pane.terminal)
      const storePtyId = useAppStore.getState().ptyIdsByTabId?.[deps.tabId]?.[0] ?? null
      void requestTerminalPaneRecovery({
        tabId: deps.tabId,
        ptyId: transport.getPtyId() ?? storePtyId,
        reason,
        terminalRecoveryGeneration,
        terminalRecoveryInstanceId: terminalRecoveryInstance.id
      })
    }
  )

  const onDataDisposable = pane.terminal.onData((data) => {
    // Why: xterm auto-replies to embedded query sequences (DA1, DECRQM,
    // OSC 10/11, focus, CPR) via onData. When we replay recorded PTY bytes
    // into xterm for scrollback/cold-restore/snapshot, those queries would
    // otherwise pipe replies into the freshly spawned shell as stray input
    // ("?1;2c", "2026;2$y", OSC color fragments, ...). The replay sites
    // engage the guard via replayIntoTerminal; here we drop everything
    // xterm emits while the guard is active. See replay-guard.ts.
    if (isPaneReplaying(deps.replayingPanesRef, pane.id)) {
      return
    }
    const currentPtyId = transport.getPtyId()
    // Why: after a Codex account switch, the runtime auth has already moved to
    // the newly selected account. Stale panes must not keep sending input until
    // they restart, or work can execute under the wrong account while the UI
    // still says the pane is stale. Fall back to the tab's persisted PTY ID so
    // the block still holds during reconnect races before the live transport has
    // updated its local PTY binding.
    if (
      isCodexPaneStale({
        tabId: deps.tabId,
        worktreeId: deps.worktreeId,
        panePtyId: currentPtyId
      })
    ) {
      clearPendingTerminalInputIntent()
      return
    }
    // Why: presence-lock input drop. While mobile is the driver for this
    // PTY, desktop keystrokes must not reach the shell; the visible overlay's
    // explicit Take back action owns restoring desktop input and dimensions.
    if (currentPtyId && isPtyLocked(currentPtyId)) {
      clearPendingTerminalInputIntent()
      return
    }
    if (
      isNativeWindowsConpty &&
      suppressNativeWindowsIdleCodexFocusReports &&
      (data === TERMINAL_FOCUS_IN_SEQUENCE || data === TERMINAL_FOCUS_OUT_SEQUENCE)
    ) {
      // Why: Codex can leave focus reporting armed after a Windows turn, but
      // disabling the mode would permanently silence focus events on resume.
      return
    }
    // Why: xterm answers CPR/DSR/DA queries natively through this same onData
    // stream (mixed with keystrokes). Those replies are latency-critical — a
    // querying program reads them in raw mode with a short timeout — so send
    // them immediately, skipping the remote input debounce that would corrupt
    // them (#7329). They are not user input, so they bypass intent inference and
    // activity recording below. No pending-intent guard: the only intents are
    // plain-escape (`\x1b`) and ctrl-c (`\x03`), neither of which can satisfy
    // isTerminalQueryReply (it requires length >= 3 and a full reply grammar),
    // so a real keystroke never reaches this branch.
    if (isTerminalQueryReply(data)) {
      sendDesktopQueryReplyImmediate(data)
      return
    }
    const intent = pendingTerminalInputIntent
    // Why: real xterm can deliver the terminal byte even when our DOM keydown
    // listener missed the press. Exact Ctrl+C/Escape bytes are still safe to
    // infer for local/remote acknowledged writes; SSH fire-and-forget remains
    // excluded because those transports do not expose sendInputAccepted.
    const acknowledgedIntent = intent ?? inferIntentFromExactTerminalInput(data)
    if (acknowledgedIntent && transport.sendInputAccepted) {
      claimViewportForUserActivity()
      if (acknowledgedIntent === 'ctrl-c') {
        // Why: the accepted-write callback is async; let the next command be
        // inferred if the user cancelled an oversized line and immediately typed.
        cancelSuspendedShellCommandInference()
      }
      clearPendingTerminalInputIntent()
      markTerminalInputSent()
      const writePromise = transport
        .sendInputAccepted(data)
        .then((accepted) => {
          if (accepted) {
            recordTerminalInputForHibernationFallback()
            observeAcceptedShellCommandInput(data)
            observeAcceptedTerminalInput(data, acknowledgedIntent)
            interruptInference.observeInputIntent(acknowledgedIntent)
            observeTitleOnlyInterrupt()
          } else {
            // Why: Esc/Ctrl+C are the first keys users press on a frozen pane;
            // an unbound-transport reject here must arm recovery too.
            requestRecoveryForUndeliverableInput()
          }
        })
        .catch((err) => {
          console.warn('[agent-interrupt] acknowledged terminal input failed:', err)
        })
      setPendingTerminalInputWrite(writePromise)
      return
    }
    if (intent) {
      claimViewportForUserActivity()
      if (transport.sendInput(data)) {
        markAcceptedTerminalInputSent()
        observeAcceptedShellCommandInput(data)
        observeAcceptedTerminalInput(data, intent)
      } else {
        requestRecoveryForUndeliverableInput()
      }
      clearPendingTerminalInputIntent()
      return
    }
    claimViewportForUserActivity()
    if (transport.sendInput(data)) {
      markAcceptedTerminalInputSent()
      observeAcceptedShellCommandInput(data)
      observeAcceptedTerminalInput(data)
      observeSentTerminalInputIntent(data)
    } else {
      clearPendingTerminalInputIntent()
      requestRecoveryForUndeliverableInput()
    }
  })

  const shouldSuppressDesktopPtyResize = (): boolean => {
    const currentPtyId = transport.getPtyId()
    return Boolean(
      currentPtyId && (getFitOverrideForPty(currentPtyId) || isPtyLocked(currentPtyId))
    )
  }

  const isRendererPtyResizeAuthoritative = (): boolean => {
    if (deps.isVisibleRef.current) {
      return true
    }
    // Why: hidden-tab layout churn is not authoritative; visible resume
    // owns correction, and hidden SIGWINCH can reset full-screen TUIs.
    return false
  }

  const forwardPtyResize = (cols: number, rows: number): void => {
    if (!isRendererPtyResizeAuthoritative()) {
      return
    }
    // Why: when a mobile-fit override is active OR mobile is currently the
    // driver of this PTY, the PTY is already at phone dims and any desktop
    // resize is wrong. Suppress resize forwarding to avoid spurious SIGWINCH
    // signals (TUI flicker / wrap corruption). Both checks are needed:
    // - getFitOverrideForPty covers the "phone-fit dims" state.
    // - isPtyLocked covers the broader "mobile driving" state, including
    //   transitions where override may not be set (e.g. legacy code paths).
    // The pty:resize IPC has a defense-in-depth twin. See
    // docs/mobile-presence-lock.md.
    if (shouldSuppressDesktopPtyResize()) {
      return
    }
    if (queuePanePtyResizeIfHeld(pane.container, cols, rows)) {
      return
    }
    transport.resize(cols, rows, { claim: true })
  }

  const onHeldPtyResizeFlush = (event: Event): void => {
    const detail = (event as CustomEvent<PanePtyResizeHoldFlushDetail>).detail
    if (!detail) {
      return
    }
    forwardPtyResize(detail.cols, detail.rows)
  }
  pane.container.addEventListener(PANE_PTY_RESIZE_HOLD_FLUSH_EVENT, onHeldPtyResizeFlush)

  const onResizeDisposable = pane.terminal.onResize(({ cols, rows }) => {
    if (suppressStructuralReplayPtyResize || suppressViewportClaimTerminalResize) {
      return
    }
    forwardPtyResize(cols, rows)
  })

  // Why: a rewrite chunk can enter AND exit the alternate screen in one parse
  // (fast-quitting TUI), netting buffer.active.type back to 'normal'; counting
  // switches keeps those redraws visible to the atlas-recovery check.
  let alternateScreenBufferSwitches = 0
  const onBufferChangeDisposable = pane.terminal.buffer.onBufferChange?.(() => {
    alternateScreenBufferSwitches += 1
  })

  // Why: renderer resize forwarding is fire-and-forget. A visible pane can
  // finish with xterm at the right grid while the PTY silently kept an older
  // grid, so Codex keeps composing against stale columns. Fit first so xterm's
  // normal onResize can send, then read applied PTY size and repair only drift.
  const ptySizeReassertion = createPtySizeReassertion({
    isDisposed: () => disposed,
    getPtyId: () => transport.getPtyId(),
    isRemotePtyId: isRemoteRuntimePtyId,
    shouldSuppressDesktopResize: () => shouldSuppressDesktopPtyResize(),
    fitAndRun: (continuation) => safeFitAndThen(pane, 'pty-size-reassertion', continuation),
    getTerminalDimensions: () => ({ cols: pane.terminal.cols, rows: pane.terminal.rows }),
    getAppliedSize: async (ptyId) => {
      // Why: e2e seam — delays the read past the reveal fit to reproduce the
      // busy-daemon/SSH ordering; returns 0 outside e2e builds.
      const delayMs = getAppliedSizeReadE2eDelayMs()
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return window.api.pty.getSize(ptyId)
    },
    forwardResize: forwardPtyResize
  })
  let pendingForegroundGridDriftCheckRaf: number | null = null
  let lastForegroundGridDriftCheckAt = Number.NEGATIVE_INFINITY
  const readProposedTerminalGrid = (): { cols: number; rows: number } | null => {
    try {
      const proposed = pane.fitAddon.proposeDimensions()
      if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) {
        return null
      }
      return proposed
    } catch {
      return null
    }
  }
  const terminalGridDriftedFromFit = (): boolean => {
    const proposed = readProposedTerminalGrid()
    return Boolean(
      proposed && (pane.terminal.cols !== proposed.cols || pane.terminal.rows !== proposed.rows)
    )
  }
  const scheduleForegroundGridDriftCheck = (): void => {
    // Why: mobile-owned PTYs intentionally keep a non-desktop grid; drift
    // healing would refit xterm even if resize forwarding is later suppressed.
    if (
      disposed ||
      !deps.isVisibleRef.current ||
      shouldSuppressDesktopPtyResize() ||
      pendingForegroundGridDriftCheckRaf !== null
    ) {
      return
    }
    const now = performance.now()
    if (now - lastForegroundGridDriftCheckAt < FOREGROUND_GRID_DRIFT_CHECK_MIN_MS) {
      return
    }
    lastForegroundGridDriftCheckAt = now
    pendingForegroundGridDriftCheckRaf = requestAnimationFrame(() => {
      pendingForegroundGridDriftCheckRaf = null
      if (
        disposed ||
        !deps.isVisibleRef.current ||
        shouldSuppressDesktopPtyResize() ||
        !terminalGridDriftedFromFit()
      ) {
        return
      }
      // Why: xterm cell metrics can settle after the DOM box stops resizing, so
      // ResizeObserver never fires even though FitAddon now proposes more cols.
      requestStablePaneFit(pane as ManagedPaneInternal, () =>
        ptySizeReassertion.request({ fit: false })
      )
    })
  }

  // Why: observe the outer pane as the layout signal for both desktop drift
  // healing and mobile take-back. Normal desktop panes compare xterm against
  // the PTY's applied size; mobile-fit panes only report desktop geometry so
  // the parked phone-sized PTY is not resized. See docs/mobile-fit-hold.md.
  let pendingGeometryReportRaf: number | null = null
  let lastObservedDesktopGrid: { cols: number; rows: number } | null = null
  const readPaneSize = (): { width: number; height: number } | null => {
    if (typeof pane.container.getBoundingClientRect !== 'function') {
      return null
    }
    const rect = pane.container.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }
  let lastObservedPaneSize = readPaneSize()
  let pendingPaneGeometryChanged = false
  const handleObservedPaneGeometry = (): void => {
    pendingGeometryReportRaf = null
    if (disposed) {
      return
    }
    if (
      deferTerminalGeometryMutationDuringRebuild(
        pane.terminal,
        'observed-pane-geometry',
        handleObservedPaneGeometry
      )
    ) {
      return
    }
    const paneGeometryChanged = pendingPaneGeometryChanged
    pendingPaneGeometryChanged = false
    const currentPtyId = transport.getPtyId()
    if (!currentPtyId) {
      // Why: ResizeObserver may deliver its initial measurement before the
      // remote binding completes; retain that passive baseline for the first
      // real focused resize instead of swallowing the user's first claim.
      const proposed = readProposedTerminalGrid()
      if (proposed) {
        lastObservedDesktopGrid = proposed
      }
      return
    }
    const fitOverride = getFitOverrideForPty(currentPtyId)
    if (!fitOverride) {
      if (pane.terminal.cols > 0 && pane.terminal.rows > 0) {
        // Why: record the local grid before a later remote hold parks xterm;
        // the first real window/split resize can then claim immediately.
        lastObservedDesktopGrid = {
          cols: pane.terminal.cols,
          rows: pane.terminal.rows
        }
      }
      if (shouldSuppressDesktopPtyResize()) {
        return
      }
      requestStablePaneFit(pane as ManagedPaneInternal, () =>
        ptySizeReassertion.request({ fit: false })
      )
      return
    }
    let proposed: { cols: number; rows: number } | undefined
    try {
      proposed = pane.fitAddon.proposeDimensions()
    } catch {
      proposed = undefined
    }
    if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) {
      return
    }
    const priorProposed = lastObservedDesktopGrid
    lastObservedDesktopGrid = proposed
    if (fitOverride.mode === 'remote-desktop-fit') {
      if (
        shouldClaimRemoteDesktopViewport({
          holdMode: fitOverride.mode,
          prior: priorProposed,
          current: proposed,
          paneGeometryChanged,
          paneVisible: deps.isVisibleRef.current,
          documentVisible: document.visibilityState !== 'hidden',
          documentFocused: document.hasFocus()
        })
      ) {
        // Why: a focused, visible layout change is genuine activity; release
        // the park and update xterm before claiming so the owner does not keep
        // rendering the prior owner's stale grid.
        suppressViewportClaimTerminalResize = true
        try {
          pane.terminal.resize(proposed.cols, proposed.rows)
        } finally {
          suppressViewportClaimTerminalResize = false
        }
        transport.resize(proposed.cols, proposed.rows, { claim: true })
      }
      return
    }
    if (isRemoteRuntimePtyId(currentPtyId)) {
      transport.resize(proposed.cols, proposed.rows)
    } else {
      window.api.pty.reportGeometry(currentPtyId, proposed.cols, proposed.rows)
    }
  }
  const geometryReportObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const paneSize = readPaneSize()
          if (
            paneSize &&
            lastObservedPaneSize &&
            (paneSize.width !== lastObservedPaneSize.width ||
              paneSize.height !== lastObservedPaneSize.height)
          ) {
            pendingPaneGeometryChanged = true
          }
          lastObservedPaneSize = paneSize
          if (pendingGeometryReportRaf !== null) {
            return
          }
          pendingGeometryReportRaf = requestAnimationFrame(handleObservedPaneGeometry)
        })
  // Why: pane.xtermContainer is created later in pane-lifecycle's
  // attachWebgl/initial-fit path; pane.container is always present at the
  // moment connectPanePty runs (it's the .pane element). Both report the
  // same layout signal — when the outer pane resizes, the inner xterm
  // container resizes too — so this is the safe element to observe.
  if (geometryReportObserver && pane.container instanceof Element) {
    geometryReportObserver.observe(pane.container)
  }

  // Why: the deferred-rAF fit can spawn the PTY at a stale width when the pane's
  // real (e.g. split/narrower) layout has not settled by the first frame — the
  // PTY is born at the wide window width while xterm later reflows to the pane
  // width. The corrective onResize is then dropped (isRendererPtyResizeAuthoritative()
  // is false mid-mount), pinning process.stdout.columns forever and garbling
  // TUIs. The reconcile re-fits across frames until the grid settles and forces
  // the PTY to xterm's dimensions; the spawn-time sync is authoritative by
  // definition so it bypasses the visibility gate (but not the mobile-fit
  // override, which legitimately parks the PTY at phone dims). See
  // pty-size-reconcile.ts for the convergence loop.
  let ptySizeReconcileHandle: PtySizeReconcileHandle | null = null
  const reconcilePtySizeAfterSpawn = (
    ptyId: string,
    spawnCols: number,
    spawnRows: number
  ): void => {
    ptySizeReconcileHandle?.cancel()
    ptySizeReconcileHandle = reconcilePtySizeAcrossFrames({
      spawnCols,
      spawnRows,
      isAlive: () => !disposed && transport.getPtyId() === ptyId,
      // Mobile legitimately parks the PTY at phone dims; skip those frames
      // (neither fit nor forward) instead of cancelling the reconcile window.
      isParked: () => Boolean(getFitOverrideForPty(ptyId)) || isPtyLocked(ptyId),
      // Once the renderer resize is authoritative (pane visible), the live
      // onResize owns future corrections, so the reconcile can hand off after
      // the grid stabilizes. While hidden it keeps watching for a late settle.
      isAuthoritative: () => isRendererPtyResizeAuthoritative(),
      measure: () => {
        if (!safeFit(pane)) {
          return null
        }
        const cols = pane.terminal.cols
        const rows = pane.terminal.rows
        return cols > 0 && rows > 0 ? { cols, rows } : null
      },
      resize: (cols, rows) => {
        if (!shouldSuppressDesktopPtyResize()) {
          transport.resize(cols, rows)
        }
      },
      // Why: confirm the PTY actually applied the size we forwarded before the
      // reconcile hands off. transport.resize is fire-and-forget for daemon/SSH
      // PTYs, so the loop can otherwise settle on a size the PTY dropped, leaving
      // it pinned wide while xterm shows narrow — the mount-time desync. Skip
      // remote-runtime PTYs (separate viewport channel; pty:getSize never tracks
      // them) so they fall back to the grid-stable handoff.
      getAppliedSize: isRemoteRuntimePtyId(ptyId) ? undefined : () => window.api.pty.getSize(ptyId),
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(handle)
        }
      }
    })
  }

  // Defer PTY spawn/attach to next frame so FitAddon has time to calculate
  // the correct terminal dimensions from the laid-out container.
  const cancelScheduledConnectFrame = (): void => {
    if (connectFrame !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(connectFrame)
      }
      connectFrame = null
    }
  }
  const measureStartupGrid = (): { cols: number; rows: number } | null => {
    if (!safeFit(pane)) {
      return null
    }
    const cols = pane.terminal.cols
    const rows = pane.terminal.rows
    return cols > 0 && rows > 0 ? { cols, rows } : null
  }
  const shouldSettleStartupGridBeforeConnect = (): boolean =>
    Boolean(paneStartup?.command) &&
    deps.isVisibleRef.current &&
    !connectionId &&
    runtimeEnvironmentId === null
  const isStartupGridReadyForConnect = (): boolean => {
    const setupSplitDirection = paneStartup?.waitForSetupSplitDirection
    if (!setupSplitDirection) {
      return true
    }
    // Why: the setup split reparents the main pane before its xterm grid
    // necessarily reflects the new flex geometry; wait for both to agree.
    return isSetupSplitGeometryReady(pane, manager, setupSplitDirection)
  }
  const settleStartupGridBeforeConnect = (connect: () => void): void => {
    startupGridSettleHandle?.cancel()
    let settledSynchronously = false
    // Why: local startup commands can launch a TUI before the split-pane grid
    // has settled; spawn from a briefly stable grid so the TUI paints cleanly.
    const handle = waitForStableStartupGrid({
      isAlive: () => !disposed,
      isReadyToSettle: paneStartup?.waitForSetupSplitDirection
        ? isStartupGridReadyForConnect
        : undefined,
      measure: measureStartupGrid,
      onSettled: () => {
        settledSynchronously = true
        startupGridSettleHandle = null
        connect()
      },
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(handle)
        }
      }
    })
    if (!settledSynchronously) {
      startupGridSettleHandle = handle
    }
  }
  const runDeferredConnect = (): void => {
    if (connectStarted) {
      return
    }
    if (!startupGridSettledForConnect && shouldSettleStartupGridBeforeConnect()) {
      cancelScheduledConnectFrame()
      if (connectFallbackTimer !== null) {
        clearTimeout(connectFallbackTimer)
        connectFallbackTimer = null
      }
      settleStartupGridBeforeConnect(() => {
        startupGridSettledForConnect = true
        runDeferredConnect()
      })
      return
    }
    connectStarted = true
    cancelScheduledConnectFrame()
    if (connectFallbackTimer !== null) {
      clearTimeout(connectFallbackTimer)
      connectFallbackTimer = null
    }
    if (disposed) {
      return
    }
    safeFit(pane)
    const cols = pane.terminal.cols
    const rows = pane.terminal.rows

    // Why: if fitAddon resolved to 0×0, the container likely has no layout
    // dimensions (display:none, unmounted, or zero-size parent). Surface a
    // diagnostic so the user sees something instead of a blank pane.
    // Gate on visibility: background/hidden tabs (orchestration workers, CLI
    // `terminal create` without --focus) legitimately connect at 0×0 because
    // safeFit skips fitting unmeasurable panes; they refit via the pane resize
    // observer once shown, so the diagnostic must not fire while hidden.
    if ((cols === 0 || rows === 0) && deps.isVisibleRef.current) {
      deps.onPtyErrorRef?.current?.(pane.id, createTerminalZeroDimensionsMessage(cols, rows))
    }

    const reportError = (message: string): void => {
      // Why: the transport connect can reject asynchronously after the pane has been
      // disposed (e.g. its workspace was deleted) — dropping a late error avoids a toast
      // racing the unmount. Mirrors the connect scheduler's disposed guard above.
      if (disposed) {
        return
      }
      deps.onPtyErrorRef?.current?.(pane.id, message)
    }

    // Why: shared registration so both fresh-spawn and reattach paths install
    // the same SerializeAddon-backed serializer plus the onTitleChange wrapper
    // that drives lastTitle parity for mobile subscribers. Wires the resulting
    // unregister into onDataDisposable.dispose so disposal stays a single
    // teardown point. See docs/mobile-prefer-renderer-scrollback.md.
    const registerPaneSerializerFor = (ptyId: string): void => {
      // Why: StrictMode mounts panes twice; the first mount is disposed
      // before the second runs, but its pty:spawn IPC may have resolved by
      // the time `disposed` flips. Without this guard, the disposed first
      // mount would register against a torn-down xterm and replace the live
      // second-mount registration via owner-token shadowing.
      if (disposed) {
        return
      }
      const unregisterSerializer = registerPtySerializer(
        ptyId,
        async (opts) => {
          try {
            if (isTerminalWritePipelineCertifiedDead(pane.terminal)) {
              return null
            }
            await waitForTerminalOutputParsed(pane.terminal)
            // Certification can land while the serializer waits for an older
            // write; never publish a fossil frame from a dead renderer.
            if (isTerminalWritePipelineCertifiedDead(pane.terminal)) {
              return null
            }
            // Why: alt-screen TUIs (vim, claude-code) hold transient state in
            // the alternate screen. The hydration path requests
            // altScreenForcesZeroRows so normal-buffer scrollback isn't bled
            // into the seed when the user is mid-TUI; the read-fallback path
            // omits it because it wants the user's currently-visible content.
            const alt = pane.terminal.buffer.active.type === 'alternate'
            // Why serializeWithAbsoluteCursor: SerializeAddon's relative
            // cursor restore lands one column short when replay of a
            // margin-filling final row leaves the target wrap-pending.
            const data =
              opts?.altScreenForcesZeroRows && alt
                ? serializeWithAbsoluteCursor(pane.serializeAddon, pane.terminal, { scrollback: 0 })
                : serializeWithAbsoluteCursor(pane.serializeAddon, pane.terminal, {
                    scrollback: opts?.scrollbackRows
                  })
            return {
              data,
              cols: pane.terminal.cols,
              rows: pane.terminal.rows,
              ...(rendererOrderedPtyId === ptyId && rendererOrderedSeq !== null
                ? { seq: rendererOrderedSeq }
                : {})
            }
          } catch {
            return null
          }
        },
        () => {
          clearHiddenOutputRestoreState()
          discardTerminalOutput(pane.terminal)
          clearTerminalScrollbackAndFollowOutput(pane.terminal)
        }
      )
      const unregisterTitleSource = registerPtyTitleSource(ptyId, (handler) =>
        pane.terminal.onTitleChange(handler)
      )
      const origOnDataDisposableDispose = onDataDisposable.dispose.bind(onDataDisposable)
      onDataDisposable.dispose = () => {
        unregisterTitleSource()
        unregisterSerializer()
        origOnDataDisposableDispose()
      }
    }

    let replayWriteQueue = Promise.resolve()
    const settlePaneSerializerAfterReplay = async (
      ptyId: string,
      generation: number
    ): Promise<void> => {
      try {
        await replayWriteQueue
        if (disposed || transport.getPtyId() !== ptyId) {
          await window.api.pty.clearPendingPaneSerializer(cacheKey, generation).catch(() => {})
          return
        }
        await waitForTerminalOutputParsed(pane.terminal)
        if (!disposed && transport.getPtyId() === ptyId) {
          await window.api.pty.settlePaneSerializer(cacheKey, generation)
          return
        }
      } catch {
        // Clear below so a failed parser/replay cannot leave the pane generation pending.
      }
      await window.api.pty.clearPendingPaneSerializer(cacheKey, generation).catch(() => {})
    }
    const reportRemoteRendererSerializerReady = (): void => {
      const ptyId = transport.getPtyId()
      if (!ptyId || !isRemoteRuntimePtyId(ptyId)) {
        return
      }
      if (!hasPtySerializer(ptyId)) {
        registerPaneSerializerFor(ptyId)
      }
      // Why: onSubscribed follows the snapshot callback, but replay drains
      // asynchronously; join it and xterm's parser before reporting readiness.
      void replayWriteQueue
        .then(() => waitForTerminalOutputParsed(pane.terminal))
        .then(() => {
          if (!disposed && transport.getPtyId() === ptyId) {
            void window.api.pty.reportRendererSerializerReady?.(ptyId)
          }
        })
        .catch(() => {})
    }

    // Why: for ordinary local startup commands, the local PTY provider already
    // writes via the shell-ready barrier. terminal-paste and SSH startup
    // commands stay renderer-delivered so xterm/relay can apply their handling.
    let pendingStartupCommand: PendingStartupCommand | null =
      shouldDeliverStartupViaTerminalPaste || connectionId
        ? paneStartup?.command
          ? { command: paneStartup.command }
          : null
        : null
    const startupShellReadyCommandHint = resolveSetupAgentSequenceLaunchCommand(
      paneStartup?.env ?? {},
      paneStartup?.command
    )
    const shouldWaitForSshShellReady =
      Boolean(connectionId) &&
      shouldUseShellReadyStartupDelivery({
        command: startupShellReadyCommandHint,
        startupCommandDelivery: paneStartup?.startupCommandDelivery
      }) &&
      !shouldDeliverStartupViaTerminalPaste
    const sshShellReadyMarkerScan = shouldWaitForSshShellReady
      ? createShellReadyMarkerScanState()
      : null
    let sshStartupShellReady = !shouldWaitForSshShellReady
    const markSshStartupShellReady = (): void => {
      if (sshStartupShellReady) {
        return
      }
      sshStartupShellReady = true
      if (sshShellReadyFallbackTimer !== null) {
        clearTimeout(sshShellReadyFallbackTimer)
        sshShellReadyFallbackTimer = null
      }
      schedulePendingStartupCommandDelivery()
    }
    const ownsStartupDraftPaste = claimStartupDraftPasteDelivery()
    const startupDraftReadyScanner = ownsStartupDraftPaste
      ? createDraftPasteReadyScanner(
          startupDraftAgentConfig?.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
        )
      : null
    let startupDraftReadinessArmed = false
    let startupDraftPasteSettled = !ownsStartupDraftPaste
    let startupDraftPasteInFlight = false
    let startupDraftInputRecorded = false
    let startupDraftQuietTimer: ReturnType<typeof setTimeout> | null = null
    let startupDraftHardTimer: ReturnType<typeof setTimeout> | null = null
    const clearStartupDraftPasteTimers = (): void => {
      if (startupDraftQuietTimer !== null) {
        clearTimeout(startupDraftQuietTimer)
        startupDraftQuietTimer = null
      }
      if (startupDraftHardTimer !== null) {
        clearTimeout(startupDraftHardTimer)
        startupDraftHardTimer = null
      }
    }
    cleanupStartupDraftPasteTimers = clearStartupDraftPasteTimers
    const getStartupDraftPtyId = (): string | null => {
      const ptyId = transport.getPtyId()
      if (
        !ptyId ||
        disposed ||
        deps.paneTransportsRef.current.get(pane.id) !== transport ||
        transport.getPtyId() !== ptyId
      ) {
        return null
      }
      return ptyId
    }
    const sendStartupDraftPaste = (): void => {
      if (
        !startupDraftPrompt ||
        startupDraftPasteSettled ||
        startupDraftPasteInFlight ||
        !startupDraftReadinessArmed
      ) {
        return
      }
      const ptyId = getStartupDraftPtyId()
      if (!ptyId) {
        return
      }
      startupDraftPasteInFlight = true
      startupDraftPasteSettled = true
      startupDraftPasteAttempted = true
      cleanupStartupDraftPasteTimers()
      const settings = getSettingsForWorktreeRuntimeOwner(useAppStore.getState(), deps.worktreeId)
      // Why: xterm focus reports share this transport queue. Bypassing it can
      // race CSI I against the draft on ConPTY and expose a literal `[I` prefix.
      void sendAgentDraftPasteContent(settings, ptyId, startupDraftPrompt, async (data) => {
        const accepted = await writeTerminalPastePtyInput(transport, data)
        if (accepted && !startupDraftInputRecorded) {
          // Why: this transport write bypasses xterm's user-input signal; keep
          // the composed draft from being discarded by later hibernation.
          startupDraftInputRecorded = true
          recordTerminalInputForHibernation()
        }
        return accepted
      })
        .catch(() => false)
        .finally(() => {
          startupDraftPasteInFlight = false
        })
    }
    const deliverStartupDraftIfAgentOwnsPty = async (): Promise<void> => {
      if (!startupDraftAgentConfig || startupDraftPasteSettled) {
        return
      }
      const ptyId = getStartupDraftPtyId()
      if (!ptyId) {
        return
      }
      const settings = getSettingsForWorktreeRuntimeOwner(useAppStore.getState(), deps.worktreeId)
      try {
        const process = await inspectRuntimeTerminalProcess(settings, ptyId)
        const foreground = process.foregroundProcess?.toLowerCase() ?? ''
        if (
          getStartupDraftPtyId() === ptyId &&
          isExpectedAgentProcess(foreground, startupDraftAgentConfig.expectedProcess)
        ) {
          sendStartupDraftPaste()
        }
      } catch {
        // Best-effort fallback; the primary path is the PTY readiness marker.
      }
    }
    const armStartupDraftHardTimer = (): void => {
      if (!startupDraftReadyScanner || startupDraftPasteSettled || startupDraftHardTimer !== null) {
        return
      }
      startupDraftHardTimer = setTimeout(() => {
        startupDraftHardTimer = null
        void deliverStartupDraftIfAgentOwnsPty()
      }, STARTUP_DRAFT_PASTE_TIMEOUT_MS)
    }
    const armStartupDraftQuietTimer = (): void => {
      if (!startupDraftReadyScanner || startupDraftPasteSettled) {
        return
      }
      if (startupDraftQuietTimer !== null) {
        clearTimeout(startupDraftQuietTimer)
      }
      startupDraftQuietTimer = setTimeout(() => {
        startupDraftQuietTimer = null
        sendStartupDraftPaste()
      }, STARTUP_DRAFT_PASTE_QUIET_MS)
    }
    const armStartupDraftReadinessObservation = (): void => {
      if (!startupDraftReadyScanner || startupDraftReadinessArmed) {
        return
      }
      startupDraftReadinessArmed = true
      armStartupDraftHardTimer()
    }
    const observeStartupDraftPasteReadiness = (data: string): void => {
      if (!startupDraftReadyScanner || !startupDraftReadinessArmed || startupDraftPasteSettled) {
        return
      }
      const scanned = startupDraftReadyScanner.observe(data)
      if (scanned.ready) {
        sendStartupDraftPaste()
        return
      }
      if (scanned.armQuietTimer) {
        armStartupDraftQuietTimer()
      }
    }
    if (ownsStartupDraftPaste && !connectionId && !shouldDeliverStartupViaTerminalPaste) {
      armStartupDraftReadinessObservation()
    }
    let sessionRestoredBannerShown = false
    const showSessionRestoredBanner = (): void => {
      if (sessionRestoredBannerShown) {
        return
      }
      sessionRestoredBannerShown = true
      deps.onShowSessionRestoredBanner(pane.id)
    }
    const getColdRestoreAgentResumePlatform = (): NodeJS.Platform => {
      if (projectRuntime?.status === 'repair-required') {
        return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
      }
      if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
        return 'linux'
      }
      if (connectionId || (worktree?.path && isWslUncPath(worktree.path))) {
        return 'linux'
      }
      return CLIENT_PLATFORM
    }
    const buildColdRestoreAgentResumeStartup = (): ColdRestoreAgentResumeStartup | null => {
      if (pendingStartupCommand) {
        return null
      }
      const state = useAppStore.getState()
      const entry = state.agentStatusByPaneKey[cacheKey]
      const sleepingRecordEntry = getSleepingRecordForPane(state)
      const sleepingRecord = sleepingRecordEntry?.record
      const useLiveEntry = entry && entry.state !== 'done'
      const agent = useLiveEntry ? entry.agentType : sleepingRecord?.agent
      if (!agent || !isResumableTuiAgent(agent)) {
        return null
      }
      const providerSession = normalizeAgentProviderSession(
        useLiveEntry ? entry.providerSession : sleepingRecord?.providerSession
      )
      if (!providerSession) {
        return null
      }
      const matchingSleepingLaunchConfig =
        sleepingRecord?.launchConfig &&
        (!useLiveEntry ||
          (sleepingRecord.agent === agent &&
            agentProviderSessionsEqual(agent, sleepingRecord.providerSession, providerSession)))
          ? sleepingRecord.launchConfig
          : undefined
      const launchConfig =
        (useLiveEntry && entry ? state.getAgentLaunchConfigForStatusEntry(entry) : undefined) ??
        matchingSleepingLaunchConfig
      const resumePlatform = getColdRestoreAgentResumePlatform()
      const startupPlan = buildAgentResumeStartupPlan({
        agent,
        providerSession,
        cmdOverrides: state.settings?.agentCmdOverrides ?? {},
        agentArgs:
          launchConfig !== undefined
            ? launchConfig.agentArgs
            : resolveTuiAgentLaunchArgs(agent, state.settings?.agentDefaultArgs),
        agentEnv:
          launchConfig !== undefined
            ? launchConfig.agentEnv
            : resolveTuiAgentLaunchEnv(agent, state.settings?.agentDefaultEnv),
        ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
        platform: resumePlatform
      })
      if (!startupPlan) {
        return null
      }
      const coldRestoreLaunchToken = createBrowserUuid()
      // Why: cold restore means the PTY process is gone but the agent provider
      // session is still resumable, so the replacement spawn must launch it.
      return {
        agent,
        command: startupPlan.launchCommand,
        env: {
          ...startupPlan.env,
          ORCA_AGENT_LAUNCH_TOKEN: coldRestoreLaunchToken
        },
        launchConfig: startupPlan.launchConfig,
        launchToken: coldRestoreLaunchToken,
        useLiveEntry: Boolean(useLiveEntry),
        hasSleepingRecord: Boolean(sleepingRecord),
        sleepingRecordEntry
      }
    }
    const applyColdRestoreAgentResumeStartup = (
      startup: ColdRestoreAgentResumeStartup | null
    ): boolean => {
      if (!startup) {
        return false
      }
      const state = useAppStore.getState()
      state.registerAgentLaunchConfig(cacheKey, startup.launchConfig, {
        agentType: startup.agent,
        launchToken: startup.launchToken,
        tabId: deps.tabId,
        leafId: pane.leafId
      })
      return true
    }
    const clearSleepingRecordAfterColdRestoreSpawn = (
      startup: ColdRestoreAgentResumeStartup | null
    ): void => {
      if (startup && !startup.useLiveEntry && startup.sleepingRecordEntry) {
        clearSleepingRecordProviderDuplicates(useAppStore.getState(), startup.sleepingRecordEntry)
      }
    }
    const mergeStartupEnvWithPaneIdentity = (
      env: Record<string, string> | undefined
    ): Record<string, string> | undefined =>
      env
        ? {
            ...env,
            ...paneIdentityEnv,
            ...(env.ORCA_AGENT_LAUNCH_TOKEN
              ? { ORCA_AGENT_LAUNCH_TOKEN: env.ORCA_AGENT_LAUNCH_TOKEN }
              : {})
          }
        : undefined
    const startFreshColdRestoreAgentResume = (
      startup: ColdRestoreAgentResumeStartup | null = buildColdRestoreAgentResumeStartup(),
      options: FreshSpawnOptions = {}
    ): Promise<string | null> => {
      applyColdRestoreAgentResumeStartup(startup)
      return startFreshSpawn(startup, options)
    }
    // Why: the hibernation wake fires from noteVisibilityResume in the outer
    // connection scope, long after this deferred-connect closure has run.
    wakeHibernatedAgentPane = () => startFreshColdRestoreAgentResume()
    const isStartupPasteTargetCurrent = (ptyId: string | null): boolean =>
      !disposed &&
      deps.paneTransportsRef.current.get(pane.id) === transport &&
      transport.getPtyId() === ptyId
    const runTerminalPasteStartupCommand = async (command: string): Promise<boolean> => {
      const ptyId = transport.getPtyId()
      const result = await executeTerminalStartupCommandPaste({
        command,
        pane,
        ptyId,
        runtime: resolveTerminalPasteRuntime({
          platform: CLIENT_PLATFORM,
          ptyId,
          connectionId,
          remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
          transport,
          isWindowsConpty: isNativeWindowsConpty
        }),
        transport,
        isTargetCurrent: isStartupPasteTargetCurrent
      })
      if (result.status !== 'pasted' || !isStartupPasteTargetCurrent(ptyId)) {
        return false
      }
      return transport.sendInput('\r')
    }
    const schedulePendingStartupCommandDelivery = (): void => {
      if (!pendingStartupCommand) {
        return
      }
      if (!sshStartupShellReady) {
        if (sshShellReadyFallbackTimer === null) {
          // Why: some SSH shells cannot emit Orca's ready marker. Prefer the
          // marker when available, but fall back to the old renderer delivery
          // behavior instead of dropping the startup command forever.
          sshShellReadyFallbackTimer = setTimeout(() => {
            sshShellReadyFallbackTimer = null
            markSshStartupShellReady()
          }, SSH_SHELL_READY_STARTUP_FALLBACK_MS)
        }
        return
      }
      if (startupInjectTimer !== null) {
        clearTimeout(startupInjectTimer)
      }
      startupInjectTimer = setTimeout(() => {
        startupInjectTimer = null
        void (async () => {
          const startup = pendingStartupCommand
          if (!startup || disposed) {
            return
          }
          if (shouldDeliverStartupViaTerminalPaste) {
            await waitForTerminalOutputParsed(pane.terminal)
          }
          if (pendingStartupCommand !== startup || disposed) {
            return
          }
          const command = startup.command
          const submitted = shouldDeliverStartupViaTerminalPaste
            ? await runTerminalPasteStartupCommand(command)
            : transport.sendInput(`${command}\r`)
          if (submitted) {
            armStartupDraftReadinessObservation()
          } else {
            releaseUnattemptedStartupDraftPasteDelivery()
          }
          pendingStartupCommand = null
        })()
      }, 50)
    }

    let freshSpawnFollowResetDisposables: IDisposable[] = []
    cancelFreshSpawnFollowReset = (): void => {
      for (const disposable of freshSpawnFollowResetDisposables) {
        disposable.dispose()
      }
      freshSpawnFollowResetDisposables = []
    }
    const resetFreshSpawnFollowOutput = (): void => {
      cancelFreshSpawnFollowReset()
      markTerminalFollowOutput(pane.terminal)
      let nativeFollowResetComplete = false
      const tryResetNativeFollow = (): void => {
        if (
          disposed ||
          getTerminalScrollIntentKind(pane.terminal) !== 'followOutput' ||
          deferTerminalGeometryMutationDuringRebuild(
            pane.terminal,
            'fresh-spawn-follow-reset',
            tryResetNativeFollow
          )
        ) {
          return
        }
        try {
          pane.terminal.scrollToBottom()
          nativeFollowResetComplete = true
          cancelFreshSpawnFollowReset()
        } catch (err) {
          if (!(err instanceof TypeError && /dimensions/.test(err.message))) {
            cancelFreshSpawnFollowReset()
            throw err
          }
        }
      }
      tryResetNativeFollow()
      if (!nativeFollowResetComplete) {
        // Why: xterm's browser viewport can reject scrolling while its renderer
        // is detached; the first render/resize is the earliest safe native retry.
        freshSpawnFollowResetDisposables = [
          pane.terminal.onRender(tryResetNativeFollow),
          pane.terminal.onResize(tryResetNativeFollow)
        ]
      }
    }

    const startFreshSpawn = (
      startupOverride?: PendingStartupCommand | null,
      options: FreshSpawnOptions = {}
    ): Promise<string | null> => {
      clearPaneMode2031State()
      clearHiddenOutputRestoreState()
      // Why: a canceled old replay clear can preserve xterm's native
      // isUserScrolling flag. A replacement shell must start in follow mode.
      resetFreshSpawnFollowOutput()
      // Why: a fresh spawn is a new process with kitty keyboard flags at
      // zero. The exit-handler reset alone is not enough: a late exit from a
      // replaced PTY takes the stale-transport early return and skips it, so
      // a restart-in-place would leak the old TUI's flags into a fresh shell.
      kittyKeyboardModes.reset()
      prepareFreshShellViewportForSpawn(options)
      if (connectionId && startupOverride?.command) {
        // Why: SSH providers use `command` only as spawn metadata; the renderer
        // must still submit the resume command to the fresh remote shell.
        pendingStartupCommand = { command: startupOverride.command }
      }
      const coldRestoreOverride =
        startupOverride && 'launchConfig' in startupOverride
          ? (startupOverride as ColdRestoreAgentResumeStartup)
          : null
      // Why: pre-signal the main process so its cooperation gate suppresses
      // the daemon-snapshot seed for this paneKey. We issue declare and the
      // spawn back-to-back without awaiting, because Electron's
      // ipcRenderer→ipcMain channel preserves order across consecutive invoke
      // calls from the same renderer. The cooperation gate at pty:spawn time
      // sees pendingByPaneKey populated. Settle/clear later echoes the gen
      // token captured here. See docs/mobile-prefer-renderer-scrollback.md.
      const preSignalPromise = runtimeEnvironmentId
        ? Promise.resolve(null)
        : window.api.pty.declarePendingPaneSerializer(cacheKey).catch(() => null)

      transportConnectInFlightSince = Date.now()
      const outputCallbacks = captureTransportOutputCallbacks(reportError)
      const spawnedRaw = transport.connect({
        url: '',
        cols,
        rows,
        ...(startupOverride?.command ? { command: startupOverride.command } : {}),
        ...(startupOverride?.env
          ? { env: mergeStartupEnvWithPaneIdentity(startupOverride.env) }
          : {}),
        ...(coldRestoreOverride ? { launchConfig: coldRestoreOverride.launchConfig } : {}),
        ...(coldRestoreOverride ? { launchToken: coldRestoreOverride.launchToken } : {}),
        ...(coldRestoreOverride ? { launchAgent: coldRestoreOverride.agent } : {}),
        ...(shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
        callbacks: outputCallbacks.callbacks
      })

      void Promise.resolve(spawnedRaw)
        .catch(() => null)
        .finally(() => {
          transportConnectInFlightSince = null
        })
      const trackedPromise: Promise<string | null> = Promise.resolve(spawnedRaw)
        .then(async (spawnedPtyId) => {
          if (outputCallbacks.generation !== transportStreamGeneration) {
            const gen = await preSignalPromise
            if (typeof gen === 'number') {
              void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
            }
            return null
          }
          const resolvedPtyId =
            spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId
              ? spawnedPtyId.id
              : typeof spawnedPtyId === 'string'
                ? spawnedPtyId
                : transport.getPtyId()
          if (spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId) {
            registerEffectiveLaunchConfig(spawnedPtyId.launchConfig, {
              ...(coldRestoreOverride ? { launchToken: coldRestoreOverride.launchToken } : {}),
              ...(coldRestoreOverride ? { launchAgent: coldRestoreOverride.agent } : {})
            })
          }
          if (resolvedPtyId) {
            if (
              spawnedPtyId &&
              typeof spawnedPtyId === 'object' &&
              spawnedPtyId.startupCwdFallback?.kind === 'worktree'
            ) {
              writeTerminalOutput(pane.terminal, STARTUP_CWD_FALLBACK_NOTICE, {
                foreground: shouldWritePtyOutputForeground(deps.isVisibleRef.current)
              })
            }
            if (coldRestoreOverride?.hasSleepingRecord) {
              showSessionRestoredBanner()
            }
            clearSleepingRecordAfterColdRestoreSpawn(coldRestoreOverride)
          } else if (
            paneStartup?.launchConfig ||
            (startupOverride && 'launchConfig' in startupOverride)
          ) {
            // Why: delayed draft/follow-up delivery keys off this launch
            // registry. If spawn produced no PTY, the launch is no longer a
            // viable delivery target and must not wait for a future pane.
            clearRegisteredStartupLaunchConfig()
          }
          if (
            resolvedPtyId &&
            spawnedPtyId &&
            typeof spawnedPtyId === 'object' &&
            'id' in spawnedPtyId &&
            activePanePtyBinding !== resolvedPtyId &&
            transport.getPtyId() === resolvedPtyId
          ) {
            // Why: daemon createOrAttach can turn an apparent fresh spawn into
            // a reattach; the transport skips onPtySpawn there to preserve recency.
            bindActivePanePty(resolvedPtyId, {
              updateTabPtyId: 'if-missing',
              sampleVisibleForegroundAgent: true
            })
          }
          if (resolvedPtyId) {
            reconcilePtySizeAfterSpawn(resolvedPtyId, cols, rows)
          }
          const gen = await preSignalPromise
          if (resolvedPtyId && (typeof gen === 'number' || isRemoteRuntimePtyId(resolvedPtyId))) {
            if (!isRemoteRuntimePtyId(resolvedPtyId) || !hasPtySerializer(resolvedPtyId)) {
              registerPaneSerializerFor(resolvedPtyId)
            }
            if (typeof gen === 'number') {
              void window.api.pty.settlePaneSerializer(cacheKey, gen).catch(() => {})
            }
          } else if (typeof gen === 'number') {
            void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
          }
          if (resolvedPtyId && connectionId) {
            schedulePendingStartupCommandDelivery()
          }
          return resolvedPtyId
        })
        .catch(async () => {
          if (paneStartup?.launchConfig || (startupOverride && 'launchConfig' in startupOverride)) {
            clearRegisteredStartupLaunchConfig()
          }
          const gen = await preSignalPromise
          if (typeof gen === 'number') {
            void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
          }
          return null
        })
        .finally(() => {
          if (pendingSpawnByPaneKey.get(pendingSpawnKey) === trackedPromise) {
            pendingSpawnByPaneKey.delete(pendingSpawnKey)
          }
        })
      // Why: split panes in the same tab can spawn concurrently. Key by pane
      // as well as tab so a remount cannot attach to a sibling setup pane's PTY.
      pendingSpawnByPaneKey.set(pendingSpawnKey, trackedPromise)
      return trackedPromise
    }

    let foregroundRefreshRiskScanTail = ''

    function trailingIncompleteCsiSequence(data: string): string {
      const escapeIndex = data.lastIndexOf('\x1b')
      if (escapeIndex === -1) {
        return ''
      }
      const tail = data.slice(escapeIndex)
      if (tail === '\x1b') {
        return tail
      }
      if (!tail.startsWith('\x1b[')) {
        return ''
      }
      for (let index = 2; index < tail.length; index++) {
        const code = tail.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) {
          return ''
        }
      }
      return tail.slice(-TERMINAL_RENDERER_RISK_SCAN_TAIL_CHARS)
    }

    function foregroundRendererRiskOutputPrefersRenderRefresh(data: string): boolean {
      if (!data) {
        return false
      }
      const scanData = foregroundRefreshRiskScanTail
        ? `${foregroundRefreshRiskScanTail}${data}`
        : data
      const prefersRefresh =
        (scanData.includes('\x1b[') || containsNonAsciiOutput(scanData)) &&
        terminalOutputPrefersRenderRefresh(scanData)
      foregroundRefreshRiskScanTail = trailingIncompleteCsiSequence(scanData)
      return prefersRefresh
    }

    function resetHiddenRendererRiskState(ptyId: string | null = null): void {
      hiddenRiskPtyId = ptyId
      hiddenSynchronizedOutputActive = false
      hiddenSynchronizedOutputMarkerTail = ''
      hiddenRewriteChunkEndedWithCarriageReturn = false
      hiddenRewriteCsiScanTail = ''
    }

    function ensureHiddenRendererRiskStateForCurrentPty(): void {
      const ptyId = transport.getPtyId()
      if (hiddenRiskPtyId === ptyId) {
        return
      }
      resetHiddenRendererRiskState(ptyId)
    }

    function resetSkippedHiddenRendererRiskState(): void {
      // Why: skipped/backlog bytes were not parsed by xterm; reset any live hidden
      // frame instead of letting dropped DEC starts make later plain bytes risky.
      resetHiddenRendererRiskState(transport.getPtyId())
    }

    function hiddenSynchronizedOutputTouchesParsedFrame(data: string): boolean {
      const scanData = hiddenSynchronizedOutputMarkerTail
        ? `${hiddenSynchronizedOutputMarkerTail}${data}`
        : data
      const currentChunkStartIndex = scanData.length - data.length
      let active = hiddenSynchronizedOutputActive
      let touchesParsedFrame = active && data.length > 0
      let offset = 0

      while (offset < scanData.length) {
        const startIndex = scanData.indexOf(SYNCHRONIZED_OUTPUT_START_SEQUENCE, offset)
        const endIndex = scanData.indexOf(SYNCHRONIZED_OUTPUT_END_SEQUENCE, offset)
        if (startIndex === -1 && endIndex === -1) {
          break
        }
        if (endIndex !== -1 && (startIndex === -1 || endIndex < startIndex)) {
          if (
            active &&
            endIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length > currentChunkStartIndex
          ) {
            touchesParsedFrame = true
          }
          active = false
          offset = endIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length
          continue
        }
        if (startIndex !== -1) {
          active = true
          if (startIndex + SYNCHRONIZED_OUTPUT_START_SEQUENCE.length > currentChunkStartIndex) {
            touchesParsedFrame = true
          }
          offset = startIndex + SYNCHRONIZED_OUTPUT_START_SEQUENCE.length
          continue
        }
      }

      if (active && data.length > 0) {
        touchesParsedFrame = true
      }
      hiddenSynchronizedOutputActive = active
      hiddenSynchronizedOutputMarkerTail = scanData.slice(-SYNCHRONIZED_OUTPUT_MARKER_TAIL_CHARS)
      return touchesParsedFrame
    }

    function hiddenTuiRedrawOutputPrefersAtlasRecovery(data: string): boolean {
      if (!data) {
        return false
      }
      const scanData = hiddenRewriteCsiScanTail ? `${hiddenRewriteCsiScanTail}${data}` : data
      const decision = terminalRewriteOutputRenderRefreshDecision(data, {
        previousChunkEndsWithCarriageReturn: hiddenRewriteChunkEndedWithCarriageReturn,
        previousRewriteCsiScanTail: hiddenRewriteCsiScanTail
      })
      hiddenRewriteChunkEndedWithCarriageReturn = decision.nextChunkEndsWithCarriageReturn
      hiddenRewriteCsiScanTail = decision.nextRewriteCsiScanTail
      return decision.prefersRenderRefresh || containsCursorPositionSequence(scanData)
    }

    function hiddenOutputNeedsAtlasRecoveryAfterParse(data: string): boolean {
      if (!data) {
        return false
      }
      ensureHiddenRendererRiskStateForCurrentPty()
      const synchronizedOutputTouchesParsedFrame = hiddenSynchronizedOutputTouchesParsedFrame(data)
      const tuiRedrawOutputPrefersAtlasRecovery = hiddenTuiRedrawOutputPrefersAtlasRecovery(data)
      return synchronizedOutputTouchesParsedFrame || tuiRedrawOutputPrefersAtlasRecovery
    }

    // The replay path uses the guard so xterm auto-replies to embedded query
    // sequences don't leak into the shell. xterm.write() buffers internally
    // regardless of DOM visibility and the guard stays engaged via the
    // write-completion callback until xterm finishes parsing.
    const writeReplayData = (data: string): void => {
      // Why: drain any queued background bytes BEFORE the replay paint, so the
      // scheduler's deferred drain cannot land older bytes on top of the replay.
      flushTerminalOutput(pane.terminal)
      replayIntoTerminal(pane, deps.replayingPanesRef, data, {
        shouldRefreshViewportSynchronously: shouldRefreshForegroundSynchronously,
        shouldReleaseRenderPause: () => deps.isVisibleRef.current
      })
    }

    const writeReplayDataAsync = (data: string): Promise<void> => {
      // Why: WebGL must be rebuilt after xterm has parsed replay bytes, not
      // merely after the write was queued.
      flushTerminalOutput(pane.terminal)
      return replayIntoTerminalAsync(pane, deps.replayingPanesRef, data, {
        shouldRefreshViewportSynchronously: shouldRefreshForegroundSynchronously,
        shouldReleaseRenderPause: () => deps.isVisibleRef.current
      })
    }

    const reattachReplayResetSequence = (payload: string): string => {
      return shouldPreserveAgentReattachModes()
        ? buildPostReplayLiveAgentReattachReset(payload)
        : POST_REPLAY_REATTACH_RESET
    }

    const consumeRestoredViewportBlankingMarker = (): boolean => {
      return deps.restoredViewportBlankingPanesRef?.current.delete(pane.id) ?? false
    }

    const writeFreshShellViewportBlanking = (rows = pane.terminal.rows): void => {
      writeReplayData(buildFreshShellViewportBlankingSequence(rows))
    }

    const prepareFreshShellViewportForSpawn = (options: FreshSpawnOptions): void => {
      const hadRestoredViewport = consumeRestoredViewportBlankingMarker()
      if (!options.forceBlankRestoredViewport && !hadRestoredViewport) {
        return
      }
      // Why: fresh Windows ConPTY output paints at screen coordinates, so
      // restored rows must leave the viewport before the first prompt redraw.
      writeFreshShellViewportBlanking()
    }

    const sendFocusedReattachFocusInAfterReplay = (
      expectedPtyId: string | null = transport.getPtyId(),
      expectedStreamGeneration = transportStreamGeneration
    ): void => {
      const scheduledGeneration = reattachReplayPayloadSignalGeneration
      void waitForTerminalOutputParsed(pane.terminal).then(() => {
        const currentPtyId = transport.getPtyId()
        if (
          disposed ||
          expectedStreamGeneration !== transportStreamGeneration ||
          currentPtyId !== expectedPtyId
        ) {
          return
        }
        // Why: a newer replay frame owns the judgment; its own post-parse
        // callback will re-evaluate against its own viewport.
        if (scheduledGeneration !== reattachReplayPayloadSignalGeneration) {
          return
        }
        // Why: the replay-byte signal also matches a dead run's screen — in
        // scrollback or still painted above a fresh shell prompt. The parsed
        // viewport is the ground truth; unless it shows a parked-cursor
        // cursor-agent screen and no status/title corroborates, downgrade to
        // the plain-shell behavior (drop focus reporting, skip focus-in).
        if (
          !hasLiveAgentReattachStatusOrTitleSignal() &&
          reattachReplayPayloadHasCursorAgentSignal
        ) {
          if (parsedViewportShowsParkedCursorAgentScreen(pane.terminal) === false) {
            reattachReplayPayloadHasCursorAgentSignal = false
            // Why: the live-agent reset preserved the payload's ?25l; a plain
            // shell never re-shows the cursor itself.
            writeReplayData(`${CURSOR_SHOW_SEQUENCE}${FOCUS_REPORTING_DISABLE_SEQUENCE}`)
            return
          }
        }
        // Why: a live TUI such as cursor-agent parks the real terminal cursor off
        // its own input caret and moves it back only on a focus-in. Reattach
        // reuses the same live PTY and the xterm textarea already holds DOM
        // focus, so xterm never emits the focus-in the agent needs and the parked
        // cursor anchors the IME/caret to the wrong cell. Gated on ?1004h so a
        // bare shell never receives a stray \x1b[I.
        const sendFocusMode = terminalHasFocusReportingEnabled(pane.terminal)
        if (!shouldSendFocusedAgentReattachFocusIn() || !sendFocusMode) {
          return
        }
        transport.sendInput(TERMINAL_FOCUS_IN_SEQUENCE)
      })
    }

    type PendingReplayData = {
      data: string
      clearBeforeReplay: boolean
      ptyId: string | null
      generation: number
      streamGeneration: number
      pendingEscapeTailAnsi?: string
    }

    let pendingReplayData: PendingReplayData | null = null
    let replayPayloadGeneration = 0
    let replayDrainQueued = false
    const drainReplayDataQueue = async (
      expectedPtyId: string | null,
      expectedStreamGeneration: number
    ): Promise<boolean> => {
      let appliedCurrentPayload = false
      while (pendingReplayData !== null) {
        if (
          pendingReplayData.ptyId !== expectedPtyId ||
          pendingReplayData.streamGeneration !== expectedStreamGeneration
        ) {
          return false
        }
        if (
          transport.getPtyId() !== expectedPtyId ||
          transportStreamGeneration !== expectedStreamGeneration
        ) {
          pendingReplayData = null
          return false
        }
        const payload = pendingReplayData
        const { data, clearBeforeReplay, pendingEscapeTailAnsi } = payload
        pendingReplayData = null
        const isCurrentPayload = (): boolean =>
          !disposed &&
          payload.generation === replayPayloadGeneration &&
          payload.streamGeneration === transportStreamGeneration &&
          transport.getPtyId() === payload.ptyId
        if (!isCurrentPayload()) {
          continue
        }
        // Relay replay buffers may overlap with content already rendered in
        // xterm. Local eager replay decides this earlier so metadata-only frames
        // can keep restored scrollback while still using the replay guard.
        if (clearBeforeReplay) {
          await writeReplayDataAsync('\x1b[2J\x1b[3J\x1b[H')
          if (!isCurrentPayload()) {
            continue
          }
        }
        if (clearBeforeReplay || data.length > 0) {
          // Why: an empty clearing frame is still an authoritative repaint and
          // must clear a stale agent signal from an earlier payload.
          rememberReattachPayloadAgentSignal(data, { fullScreenReplay: clearBeforeReplay })
        }
        // Why: replayed application bytes carry the live TUI's kitty keyboard
        // negotiation; the mirror must re-arm from them after a reload. Replay
        // semantics: relay reconnects redeliver the same window, so pushes
        // apply as sets to keep the mirrored stack from accumulating frames.
        kittyKeyboardModes.scanReplay(data)
        await writeReplayDataAsync(data)
        if (!isCurrentPayload()) {
          continue
        }
        if (clearBeforeReplay || data.length > 0) {
          await writeReplayDataAsync(reattachReplayResetSequence(data))
          if (!isCurrentPayload()) {
            continue
          }
          sendFocusedReattachFocusInAfterReplay(payload.ptyId, payload.streamGeneration)
        }
        // Why: the daemon could not serialize a PTY read that ended mid-escape,
        // so the emulator shipped the dangling partial separately. Write it LAST
        // — after the reset, whose ESC would otherwise abort it — so the next
        // live chunk completes the sequence instead of rendering literally
        // (#7329). Guarded so a later ESC cannot leave the parser wedged.
        if (pendingEscapeTailAnsi) {
          await writeReplayDataAsync(pendingEscapeTailAnsi)
        }
        if (!isCurrentPayload()) {
          continue
        }
        // Why: remote-runtime snapshots can arrive after WebGL attached to an
        // empty buffer; rebuilding after replay parses seeds the glyph atlas
        // from the now-populated xterm state.
        manager.rebuildPaneWebgl(pane.id)
        appliedCurrentPayload = true
      }
      return appliedCurrentPayload
    }
    const scheduleReplayDataDrain = (): void => {
      if (replayDrainQueued) {
        return
      }
      const scheduledPtyId = pendingReplayData?.ptyId ?? null
      replayDrainQueued = true
      // Why: live bytes are newer than the authoritative replay frame. Hold
      // them until clear + replay + reset have all parsed, or replay can erase them.
      const scheduledStreamGeneration =
        pendingReplayData?.streamGeneration ?? transportStreamGeneration
      beginReattachLiveDataDeferral(scheduledStreamGeneration)
      let replayCompleted = false
      replayWriteQueue = replayWriteQueue
        .catch(() => undefined)
        .then(() =>
          structuralReplayCoordinator.run(
            async () => {
              replayCompleted = await drainReplayDataQueue(
                scheduledPtyId,
                scheduledStreamGeneration
              )
            },
            {
              shouldRestore: () =>
                !disposed &&
                transport.getPtyId() === scheduledPtyId &&
                transportStreamGeneration === scheduledStreamGeneration
            }
          )
        )
        .then(() => {
          replayCompleted &&= !disposed && transport.getPtyId() === scheduledPtyId
        })
        .finally(() => {
          replayDrainQueued = false
          if (pendingReplayData !== null) {
            // Why: preserve the PTY identity captured when the callback fired;
            // re-reading it here could retag stale bytes for a replacement PTY.
            scheduleReplayDataDrain()
          }
          finishReattachLiveDataDeferral(replayCompleted, scheduledStreamGeneration)
        })
    }
    const replayDataCallback = (
      data: string,
      meta: { clearBeforeReplay?: boolean; pendingEscapeTailAnsi?: string } = {},
      streamGeneration = transportStreamGeneration
    ): void => {
      pendingReplayData = {
        data,
        clearBeforeReplay: meta.clearBeforeReplay !== false,
        ptyId: transport.getPtyId(),
        generation: (replayPayloadGeneration += 1),
        streamGeneration,
        ...(meta.pendingEscapeTailAnsi ? { pendingEscapeTailAnsi: meta.pendingEscapeTailAnsi } : {})
      }
      scheduleReplayDataDrain()
    }

    const captureTransportOutputCallbacks = (onError: (message: string) => void) => {
      // Why: a new stream generation cannot inherit an old replay's pending
      // destination-grid fit or keep its live-data waiter open.
      pendingHiddenSnapshotFit?.cancel()
      pendingHiddenSnapshotFit = null
      pendingReattachFit?.cancel()
      pendingReattachFit = null
      const generation = (transportStreamGeneration += 1)
      const isCurrent = (): boolean => !disposed && generation === transportStreamGeneration
      return {
        generation,
        callbacks: {
          onConnect: (): void => {
            if (isCurrent()) {
              reportRemoteRendererSerializerReady()
            }
          },
          onData: (data: string, meta?: PtyDataMeta): void => {
            if (isCurrent()) {
              dataCallback(data, meta, generation)
            }
          },
          onReplayData: (
            data: string,
            meta?: { clearBeforeReplay?: boolean; pendingEscapeTailAnsi?: string }
          ): void => {
            if (isCurrent()) {
              replayDataCallback(data, meta, generation)
            }
          },
          onError: (message: string): void => {
            if (isCurrent()) {
              onError(message)
            }
          }
        }
      }
    }

    type PendingHiddenOutputRestoreChunk = {
      data: string
      seq?: number
      rawLength?: number
    }

    let hiddenOutputRestoreNeeded = false
    let hiddenOutputRestoreInFlight: Promise<void> | null = null
    let hiddenOutputRestorePendingChunks: PendingHiddenOutputRestoreChunk[] = []
    let hiddenOutputRestorePendingChars = 0
    let hiddenOutputRestorePendingOverflow = false
    let hiddenOutputRestoreFreshSnapshotNeeded = false
    let hiddenOutputRestoreRetryDeferred = false
    let hiddenOutputRestoreScheduled = false
    let hiddenOutputRestoreDeferredRetryTimer: ReturnType<typeof setTimeout> | null = null
    let hiddenOutputRestoreForegroundDeadlineTimer: ReturnType<typeof setTimeout> | null = null
    let hiddenOutputRestoreDeferredRetryAttempts = 0
    let hiddenOutputSnapshotScrollRestore: {
      ptyId: string | null
      generation: number
      valid: boolean
      started: boolean
    } | null = null
    // Why: hidden recovery state belongs to one PTY stream. Reattach/restart
    // can reuse the pane object for a different session before visibility.
    let hiddenOutputRestorePtyId: string | null = null
    // One recovery re-kick per xterm instance. Generation-aware cooldown and
    // window-cap retries keep a fresh-but-wedged replacement from fossilizing.
    let certifiedDeadRestoreRecoveryRequested = false
    let hiddenOutputRestoreGeneration = 0
    // Flood-backpressure suppression (HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS).
    let hiddenOutputRestoreFloodSuppressedUntil = 0
    // Why: queued replay writes still paint after deadline abandonment; the
    // fallback drain must not write snapshot-covered live bytes a second time.
    let hiddenOutputRestoreReplayingSnapshot: {
      seq?: number
      pendingDeliveryStartSeq?: number
    } | null = null
    let hiddenOutputRestoreFloodRepaintTimer: ReturnType<typeof setTimeout> | null = null
    // Why: after a snapshot restore, main can still drain ACK-backlog chunks
    // whose bytes the snapshot already covers — writing them unguarded
    // duplicates visible output. Track the restored baseline seq (per PTY)
    // and the expected next chunk start so dataCallback can drop/slice
    // overlaps and detect seq gaps from main-side pending-cap trims whose
    // one-shot marker was already consumed.
    let restoredSnapshotBaselineSeq: number | null = null
    let restoredSnapshotBaselinePtyId: string | null = null
    let restoredSnapshotExpectedStartSeq: number | null = null
    // Why: main samples its pending renderer-delivery queue with the snapshot.
    // Chunks at or below this seq can never be backlog duplicates (delivery is
    // once-and-in-order), so the dedupe window is (windowStart, baseline].
    let restoredSnapshotDeliveryWindowStartSeq: number | null = null

    function setRestoredSnapshotBaseline(
      ptyId: string,
      snapshot: { seq?: number; pendingDeliveryStartSeq?: number }
    ): void {
      if (typeof snapshot.seq !== 'number') {
        clearRestoredSnapshotBaseline()
        return
      }
      const windowStartSeq =
        typeof snapshot.pendingDeliveryStartSeq === 'number'
          ? Math.min(snapshot.pendingDeliveryStartSeq, snapshot.seq)
          : null
      if (windowStartSeq !== null && windowStartSeq >= snapshot.seq) {
        // Why: main reported an empty undelivered backlog — no chunk at or
        // below the snapshot seq can ever arrive again (delivery is once and
        // in order) and a future pending-cap trim re-arms the out-of-band
        // marker. Arming a baseline anyway would misread live chunks from a
        // foreign seq domain (restarted counter / synthetic injection) as
        // duplicates or trim gaps and silently drop genuinely-new output.
        clearRestoredSnapshotBaseline()
        return
      }
      restoredSnapshotBaselineSeq = snapshot.seq
      restoredSnapshotBaselinePtyId = ptyId
      restoredSnapshotExpectedStartSeq = snapshot.seq
      restoredSnapshotDeliveryWindowStartSeq = windowStartSeq
    }

    function clearRestoredSnapshotBaseline(): void {
      restoredSnapshotBaselineSeq = null
      restoredSnapshotBaselinePtyId = null
      restoredSnapshotExpectedStartSeq = null
      restoredSnapshotDeliveryWindowStartSeq = null
    }
    let foregroundImmediateBudgetChars = 0
    let foregroundImmediateBudgetWindowStart = 0
    let foregroundRewriteChunkEndedWithCarriageReturn = false
    let foregroundRewriteCsiScanTail = ''
    let hiddenMode2031ScanTail = ''
    const shouldSnapshotHiddenCodexOutput = shouldKeepHiddenStartupRendererQueriesLive(paneStartup)
    let hiddenStartupRendererQueryPending = ''
    let hiddenRendererStateDirty = false
    let hiddenRiskPtyId: string | null = null
    let hiddenSynchronizedOutputActive = false
    let hiddenSynchronizedOutputMarkerTail = ''
    let hiddenRewriteChunkEndedWithCarriageReturn = false
    let hiddenRewriteCsiScanTail = ''
    let rendererOrderedPtyId: string | null = null
    let rendererOrderedSeq: number | null = null
    let rendererChannelSeqPtyId: string | null = null
    let rendererChannelSeq: number | null = null

    function canUseMainBufferSnapshot(ptyId: string | null): ptyId is string {
      return Boolean(ptyId) && !isRemoteRuntimePtyId(ptyId)
    }

    function canUseHiddenOutputSnapshot(ptyId: string | null): ptyId is string {
      if (!ptyId) {
        return false
      }
      if (canUseMainBufferSnapshot(ptyId)) {
        return true
      }
      return transport.getPtyId() === ptyId && typeof transport.serializeBuffer === 'function'
    }

    async function serializeHiddenOutputSnapshot(
      ptyId: string,
      opts: { scrollbackRows?: number }
    ): Promise<PtyBufferSnapshot | null> {
      const e2eSnapshot = readE2eHiddenSnapshotOverride(ptyId)
      if (e2eSnapshot) {
        return e2eSnapshot
      }
      if (canUseMainBufferSnapshot(ptyId)) {
        return window.api.pty.getMainBufferSnapshot(ptyId, opts)
      }
      if (transport.getPtyId() !== ptyId || typeof transport.serializeBuffer !== 'function') {
        return null
      }
      return transport.serializeBuffer(opts)
    }

    // Why: hidden/parked panes used to mark hidden only at the first
    // dataCallback sync, leaving a spawn-time window where neither side
    // answered queries (the spawn-time DA1 loss). Declaring hidden on the
    // spawn IPC lets main mark the PTY before its first byte — including
    // codex spawns: the model responder answers their startup probes from
    // byte zero now that the 10s renderer query window is gone.
    // Remote-runtime PTYs are never gate-markable (no local main transit).
    function shouldDeclareHiddenAtSpawn(): boolean {
      return (
        hiddenDeliveryGateActive &&
        !runtimeEnvironmentId &&
        !disposed &&
        !shouldWritePtyOutputForeground(deps.isVisibleRef.current)
      )
    }

    // ── Hidden-delivery gate sync (Phase 4) ─────────────────────────────
    // Why: marks this pane's PTY hidden in main while no visible view needs
    // its bytes; main then drops delivery after model ingestion and reveal
    // restores from the snapshot. The marked id is tracked locally so PTY
    // changes (reattach/restart) can never leave a stale id gated.
    let hiddenDeliverySyncedPtyId: string | null = null
    let releaseHiddenDeliveryClaim: (() => void) | null = null
    let modelRestoreSubscribedPtyId: string | null = null
    let unregisterModelRestoreNeeded: (() => void) | null = null

    function isHiddenOutputRestoreFloodSuppressed(): boolean {
      return Date.now() < hiddenOutputRestoreFloodSuppressedUntil
    }

    // True when a drop/gap signal on a visible pane is attributable to this
    // pane's OWN restore backpressure (a restore is replaying right now, or
    // one was just cut off for outrunning the stream). Such signals must not
    // re-arm restores — that is the rc.7.perf feedback loop.
    function isForegroundRestoreBackpressureContext(): boolean {
      return (
        shouldWritePtyOutputForeground(deps.isVisibleRef.current) &&
        (hiddenOutputRestoreInFlight !== null || isHiddenOutputRestoreFloodSuppressed())
      )
    }

    function clearHiddenOutputRestoreFloodRepaintTimer(): void {
      if (hiddenOutputRestoreFloodRepaintTimer === null) {
        return
      }
      clearTimeout(hiddenOutputRestoreFloodRepaintTimer)
      hiddenOutputRestoreFloodRepaintTimer = null
    }
    cleanupHiddenOutputRestoreFloodRepaint = clearHiddenOutputRestoreFloodRepaintTimer

    function resetHiddenOutputRestoreFloodSuppression(): void {
      hiddenOutputRestoreFloodSuppressedUntil = 0
      clearHiddenOutputRestoreFloodRepaintTimer()
    }

    // Extends the suppression window and (re)schedules the single deferred
    // repaint for when the flood goes quiet. Every backpressure signal resets
    // the timer, so it fires exactly once, SUPPRESS_MS after the last signal.
    function noteHiddenOutputRestoreFloodBackpressure(): void {
      hiddenOutputRestoreFloodSuppressedUntil = Date.now() + HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS
      const ptyId = transport.getPtyId()
      if (ptyId === null) {
        return
      }
      clearHiddenOutputRestoreFloodRepaintTimer()
      hiddenOutputRestoreFloodRepaintTimer = setTimeout(() => {
        hiddenOutputRestoreFloodRepaintTimer = null
        if (disposed || transport.getPtyId() !== ptyId) {
          return
        }
        // Why one repaint: bytes were dropped during the flood, so the screen
        // has a gap the live stream cannot heal. Now that the flood is quiet,
        // a single snapshot restore repaints from main's authoritative buffer.
        markHiddenOutputRestoreNeeded()
      }, HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS)
    }

    // Why: main reports dropped renderer-bound bytes (hidden gate / pending
    // cap) out-of-band — routed per PTY by pty-model-restore-channel.ts.
    function handleModelRestoreNeededMarker(): void {
      if (disposed) {
        return
      }
      recordTerminalFreezeBreadcrumb('restore-marker', {
        id: redactPtyIdForDiagnostics(transport.getPtyId() ?? '')
      })
      // Why: dropped bytes invalidate every cross-chunk carry — a partial
      // OSC-9999 prefix spanning the gap would corrupt the next live chunk.
      transport.resetCrossChunkParserState?.()
      // Why gated (rc.7.perf loop): on a visible pane these markers are the
      // product of our own restore starving ACKs. Re-arming per marker kept
      // the snapshot-fetch loop alive for the whole flood; defer to one
      // post-flood repaint instead and let live bytes flow.
      if (isForegroundRestoreBackpressureContext()) {
        noteHiddenOutputRestoreFloodBackpressure()
        return
      }
      // Why: parity with the hidden skip path — a marker landing while a
      // restore is in flight means the in-flight snapshot may predate the
      // drop, so a fresh snapshot must follow. Captured BEFORE the mark: on a
      // visible pane the mark starts a restore synchronously, which must not
      // count as "already in flight".
      const restoreWasInFlight = hiddenOutputRestoreInFlight !== null
      markHiddenOutputRestoreNeeded()
      if (restoreWasInFlight) {
        hiddenOutputRestoreFreshSnapshotNeeded = true
      }
    }

    function syncModelRestoreNeededSubscription(ptyId: string | null): void {
      if (modelRestoreSubscribedPtyId === ptyId) {
        return
      }
      unregisterModelRestoreNeeded?.()
      unregisterModelRestoreNeeded = null
      modelRestoreSubscribedPtyId = ptyId
      // Why: markers exist only for PTYs whose bytes transit local main;
      // remote-runtime transports are structurally unaffected.
      if (!ptyId || isRemoteRuntimePtyId(ptyId)) {
        return
      }
      unregisterModelRestoreNeeded = registerPtyModelRestoreNeededHandler(
        ptyId,
        handleModelRestoreNeededMarker
      )
    }

    syncHiddenRendererPtyDelivery = (): void => {
      const ptyId = transport.getPtyId()
      syncModelRestoreNeededSubscription(ptyId)
      if (hiddenDeliverySyncedPtyId !== null && hiddenDeliverySyncedPtyId !== ptyId) {
        releaseHiddenDeliveryClaim?.()
        releaseHiddenDeliveryClaim = null
        hiddenDeliverySyncedPtyId = null
      }
      if (!isHiddenDeliveryGateManagedPty(ptyId) || !canUseHiddenOutputSnapshot(ptyId)) {
        return
      }
      const shouldHide = !disposed && !shouldWritePtyOutputForeground(deps.isVisibleRef.current)
      const isFirstSyncForPty = hiddenDeliverySyncedPtyId !== ptyId
      hiddenDeliverySyncedPtyId = ptyId
      if (shouldHide) {
        if (!releaseHiddenDeliveryClaim) {
          releaseHiddenDeliveryClaim = acquireHiddenRendererPtyDeliveryClaim(ptyId)
        }
      } else if (releaseHiddenDeliveryClaim) {
        releaseHiddenDeliveryClaim()
        releaseHiddenDeliveryClaim = null
      } else if (isFirstSyncForPty) {
        // Why: clear unconditionally on the first sync for a PTY — a stale
        // main-side hidden bit can survive a renderer reload for
        // daemon-backed PTYs that keep their session id.
        declareRendererPtyDeliveryVisible(ptyId)
      }
    }
    releaseHiddenRendererPtyDelivery = (): void => {
      releaseHiddenDeliveryClaim?.()
      releaseHiddenDeliveryClaim = null
      hiddenDeliverySyncedPtyId = null
      unregisterModelRestoreNeeded?.()
      unregisterModelRestoreNeeded = null
      modelRestoreSubscribedPtyId = null
    }

    function beforeTerminalOutputWrite(data: string): void {
      // Why: shaping must register before xterm parses the RTL bytes that need it.
      ensureArabicShapingJoinerForText(pane.terminal, data)
      recordTerminalOutput(pane.terminal)
    }

    function consumeForegroundImmediateBudget(dataLength: number): boolean {
      const now = performance.now()
      if (now - foregroundImmediateBudgetWindowStart > FOREGROUND_BUDGET_WINDOW_MS) {
        foregroundImmediateBudgetChars = 0
        foregroundImmediateBudgetWindowStart = now
      }
      if (foregroundImmediateBudgetChars + dataLength > FOREGROUND_IMMEDIATE_BUDGET_CHARS) {
        return false
      }
      foregroundImmediateBudgetChars += dataLength
      return true
    }

    function isActiveSplitPane(): boolean {
      if (!deps.isActiveRef.current) {
        return false
      }
      const activePane = manager.getActivePane?.() ?? null
      return activePane ? activePane.id === pane.id : true
    }

    function isLatencySensitiveForegroundOutput(data: string): boolean {
      if (!isActiveSplitPane()) {
        // Why: many visible split panes can each emit tiny TUI frames. A shared
        // budget keeps watched panes live while preventing aggregate xterm work
        // from starving typing in the active pane.
        if (data.includes('\x1b[')) {
          return false
        }
        return consumeInactiveForegroundImmediateBudget(data.length)
      }
      if (data.length <= FOREGROUND_THROUGHPUT_IMMEDIATE_CHARS) {
        return consumeForegroundImmediateBudget(data.length)
      }
      const recentInput =
        performance.now() - lastTerminalInputAt <= FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS
      if (
        recentInput &&
        data.length <= FOREGROUND_INTERACTIVE_REDRAW_CHARS &&
        data.includes('\x1b[')
      ) {
        return consumeForegroundImmediateBudget(data.length)
      }
      return false
    }

    function containsNonAsciiOutput(data: string): boolean {
      for (let index = 0; index < data.length; index++) {
        if (data.charCodeAt(index) > 0x7f) {
          return true
        }
      }
      return false
    }

    function containsWindowsRewriteControl(data: string): boolean {
      return data.includes('\r') || terminalRewriteOutputPrefersRenderRefresh(data)
    }

    function foregroundRewriteOutputPrefersRenderRefresh(data: string): boolean {
      const decision = terminalRewriteOutputRenderRefreshDecision(data, {
        previousChunkEndsWithCarriageReturn: foregroundRewriteChunkEndedWithCarriageReturn,
        previousRewriteCsiScanTail: foregroundRewriteCsiScanTail
      })
      foregroundRewriteChunkEndedWithCarriageReturn = decision.nextChunkEndsWithCarriageReturn
      foregroundRewriteCsiScanTail = decision.nextRewriteCsiScanTail
      return decision.prefersRenderRefresh
    }

    // Why: Vim-style TUI redraws are plain-ASCII in-place rewrites whose erased
    // cells can keep stale WebGL glyphs until the shared atlas rebuilds. Whether
    // a rewrite touched the alternate screen is only authoritative once xterm
    // parses the chunk (enter/exit sequences can split across PTY chunks), so
    // capture the pre-parse state and decide the rest at parse completion.
    function alternateScreenRewriteAtlasRecoveryOnParsed(): () => void {
      const wasAlternateScreenBuffer = pane.terminal.buffer.active.type === 'alternate'
      const switchesBeforeParse = alternateScreenBufferSwitches
      return () => {
        if (
          wasAlternateScreenBuffer ||
          alternateScreenBufferSwitches !== switchesBeforeParse ||
          pane.terminal.buffer.active.type === 'alternate'
        ) {
          scheduleTerminalWebglAtlasRecovery()
        }
      }
    }

    function shouldForceForegroundRenderRefresh(data: string): {
      refresh: boolean
      inPlaceRewrite: boolean
      recoverWebglAtlasAfterParse: boolean
    } {
      const rewriteOutputPrefersRenderRefresh = foregroundRewriteOutputPrefersRenderRefresh(data)
      const recentInput =
        performance.now() - lastTerminalInputAt <= FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS
      if (foregroundRendererRiskOutputPrefersRenderRefresh(data)) {
        return {
          refresh: true,
          inPlaceRewrite: rewriteOutputPrefersRenderRefresh,
          recoverWebglAtlasAfterParse: true
        }
      }
      if (rewriteOutputPrefersRenderRefresh) {
        // Why: resize fixes these panes because xterm's buffer is right but
        // in-place redraw cells can remain stale in the renderer until repaint.
        return { refresh: true, inPlaceRewrite: true, recoverWebglAtlasAfterParse: false }
      }
      if (
        windowsEastAsianOutputPrefersRenderRefresh(data, {
          isWindowsClient: shouldApplyWindowsRendererUnicodeRefresh,
          isNativeWindowsConpty: shouldApplyNativeWindowsRewriteRefresh,
          hadRecentInput: recentInput,
          maxInteractiveRedrawChars: FOREGROUND_INTERACTIVE_REDRAW_CHARS
        })
      ) {
        // Why: CJK/Korean from Microsoft Pinyin commits and native ConPTY agent
        // output can leave stale wide-glyph cells in the local Windows DOM renderer.
        return { refresh: true, inPlaceRewrite: false, recoverWebglAtlasAfterParse: false }
      }
      return {
        refresh:
          shouldApplyNativeWindowsRewriteRefresh &&
          containsNonAsciiOutput(data) &&
          containsWindowsRewriteControl(data),
        inPlaceRewrite: false,
        recoverWebglAtlasAfterParse: false
      }
    }

    function respondToSkippedMode2031Subscribe(data: string): void {
      const scan = scanMode2031Sequences(hiddenMode2031ScanTail, data)
      hiddenMode2031ScanTail = scan.tail
      if (scan.finalState === 'unsubscribed') {
        deps.paneMode2031Ref.current.delete(pane.id)
        deps.paneLastThemeModeRef.current.delete(pane.id)
      }
      if (scan.finalState !== 'subscribed') {
        return
      }
      const settings = useAppStore.getState().settings
      const mode = resolveTerminalColorSchemeMode(settings, getSystemPrefersDark())
      // Why: hidden snapshot-backed panes skip xterm.write for PTY bytes. Answer
      // immediately so the reply cannot outlive the program's read window.
      deps.paneMode2031Ref.current.set(pane.id, true)
      sendDesktopQueryReplyImmediate(mode2031SequenceFor(mode))
      deps.paneLastThemeModeRef.current.set(pane.id, mode)
      recordHiddenMode2031Reply()
    }

    function writePtyOutputToXterm(
      data: string,
      foreground: boolean,
      opts?: { hiddenStartupRendererQuery?: boolean }
    ): void {
      // Why: every application byte funnels through here (foreground, hidden,
      // and background writes), so this is the one place the kitty keyboard
      // mirror observes the pane's protocol negotiation.
      kittyKeyboardModes.scan(data)
      if (foreground) {
        resetHiddenOutputRestoreIfPtyChanged()
        resetHiddenRendererRiskState()
      }
      const parseHiddenStartupOutput =
        !foreground &&
        canUseHiddenOutputSnapshot(transport.getPtyId()) &&
        shouldSnapshotHiddenCodexOutput &&
        (opts?.hiddenStartupRendererQuery === true || containsHiddenStartupRendererQuery(data))
      const synchronizedOutputStarted =
        shouldProtectNativeWindowsSynchronizedOutput &&
        foreground &&
        containsSynchronizedOutputStart(data)
      const synchronizedOutputEnded =
        shouldProtectNativeWindowsSynchronizedOutput &&
        foreground &&
        containsSynchronizedOutputEnd(data)
      const synchronizedForegroundOutput =
        shouldProtectNativeWindowsSynchronizedOutput &&
        foreground &&
        (synchronizedForegroundOutputActive || synchronizedOutputStarted || synchronizedOutputEnded)
      const nextSynchronizedForegroundOutputActive =
        shouldProtectNativeWindowsSynchronizedOutput &&
        foreground &&
        shouldSynchronizedOutputRemainActive(data, synchronizedForegroundOutputActive)
      // Why: xterm's DOM renderer draws the cursor as row content; Windows
      // cursor-only restores need row invalidation even outside DEC 2026.
      const nativeWindowsCursorRestore =
        shouldProtectNativeWindowsSynchronizedOutput && foreground && containsCursorRestore(data)
      const foregroundOutput = foreground || parseHiddenStartupOutput
      if (foreground) {
        scheduleForegroundGridDriftCheck()
      }
      const renderRefreshDecision = foregroundOutput
        ? shouldForceForegroundRenderRefresh(data)
        : { refresh: false, inPlaceRewrite: false, recoverWebglAtlasAfterParse: false }
      const recoverHiddenWebglAtlasAfterParse =
        !foregroundOutput && hiddenOutputNeedsAtlasRecoveryAfterParse(data)
      const recoverWebglAtlasAfterParse =
        renderRefreshDecision.recoverWebglAtlasAfterParse || recoverHiddenWebglAtlasAfterParse
      // Why: atlas recovery must repaint from the parsed xterm buffer, not a
      // pre-write snapshot that a late TUI redraw can immediately stale.
      const onParsedAtlasRecovery = recoverWebglAtlasAfterParse
        ? scheduleTerminalWebglAtlasRecovery
        : renderRefreshDecision.inPlaceRewrite
          ? alternateScreenRewriteAtlasRecoveryOnParsed()
          : undefined
      const foregroundRenderRefreshNeeded = renderRefreshDecision.refresh
      // Why: see nativeWindowsRewriteNeedsFollowupRenderRefresh — Claude Code's
      // in-place prompt redraws on Windows ConPTY can paint one frame late, so a
      // follow-up repaint corrects the column desync without a window resize.
      const nativeWindowsInPlaceRewriteFollowup = nativeWindowsRewriteNeedsFollowupRenderRefresh({
        isNativeWindowsConpty: shouldApplyNativeWindowsRewriteRefresh,
        isForeground: foreground,
        isInPlaceRewrite: renderRefreshDecision.inPlaceRewrite
      })
      // Why: recompute the latch on every synchronized START so each frame's
      // interactivity is judged by its own open time vs the last keystroke and
      // can't leak across a same-chunk close+open; an active frame with no new
      // start retains it (the split-end-marker headline fix), and we only clear
      // it once we leave synchronized output on a chunk that is not the end.
      if (synchronizedForegroundOutput && synchronizedOutputStarted) {
        synchronizedForegroundFrameInteractive =
          performance.now() - lastTerminalInputAt <=
          FOREGROUND_SYNCHRONIZED_FRAME_INTERACTIVE_WINDOW_MS
      } else if (!nextSynchronizedForegroundOutputActive && !synchronizedOutputEnded) {
        synchronizedForegroundFrameInteractive = false
      }
      // Why: ConPTY can split the closing chunk of a submit repaint past the
      // 150ms redraw window. Treat the whole frame as latency-sensitive when it
      // opened right after a keystroke so the scheduler drains it on the fast
      // path (~16-32ms) instead of the 1s synchronized-frame coalesce fallback.
      const synchronizedFrameLatencySensitive =
        synchronizedForegroundOutput && synchronizedForegroundFrameInteractive
      synchronizedForegroundOutputActive = nextSynchronizedForegroundOutputActive
      if (!foreground && hiddenMode2031ScanTail) {
        respondToSkippedMode2031Subscribe(data)
      }
      writeTerminalOutput(pane.terminal, data, {
        foreground: foregroundOutput,
        beforeWrite: beforeTerminalOutputWrite,
        // Why: claims the in-progress pty:data delivery's parse-deferred ACK
        // (null outside a delivery, e.g. snapshot replays / synthetic writes).
        // The FIRST scheduler write of a delivery carries the whole credit;
        // the scheduler fires it when the bytes are consumed.
        ackCredit: takeCurrentPtyDeliveryAckCredit() ?? undefined,
        onBackgroundBacklogDropped: markHiddenOutputRestoreNeeded,
        latencySensitive:
          !foreground || parseHiddenStartupOutput
            ? true
            : synchronizedFrameLatencySensitive || isLatencySensitiveForegroundOutput(data),
        forceForegroundRefresh:
          foregroundOutput &&
          (synchronizedForegroundOutput ||
            nativeWindowsCursorRestore ||
            foregroundRenderRefreshNeeded),
        followupForegroundRefresh:
          nativeWindowsCursorRestore || nativeWindowsInPlaceRewriteFollowup,
        // Why: xterm already queued a WebGL frame while parsing this chunk;
        // merge the repair into it instead of rendering the full grid twice.
        shouldRefreshForegroundSynchronously,
        onParsed: onParsedAtlasRecovery,
        stripTransientCursorShows: shouldProtectNativeWindowsSynchronizedOutput && foreground,
        coalesceForeground: synchronizedForegroundOutput && synchronizedOutputEnded,
        holdForeground: synchronizedForegroundOutput && nextSynchronizedForegroundOutputActive
      })
    }

    queueAgentIdleTerminalModeReset = (): void => {
      if (disposed) {
        return
      }
      writePtyOutputToXterm(
        idleAgentTerminalModeReset,
        shouldWritePtyOutputForeground(deps.isVisibleRef.current)
      )
    }

    function markHiddenOutputRestoreNeeded(): void {
      resetSkippedHiddenRendererRiskState()
      const ptyId = transport.getPtyId()
      if (!canUseHiddenOutputSnapshot(ptyId)) {
        return
      }
      if (hiddenOutputRestorePtyId !== null && hiddenOutputRestorePtyId !== ptyId) {
        clearHiddenOutputRestoreState()
      }
      hiddenOutputRestorePtyId = ptyId
      hiddenOutputRestoreNeeded = true
      if (shouldWritePtyOutputForeground(deps.isVisibleRef.current)) {
        requestHiddenOutputRestoreIfNeeded()
      }
    }

    function shouldSkipHiddenRendererOutput(foreground: boolean, data: string): boolean {
      if (
        foreground ||
        !shouldSnapshotHiddenCodexOutput ||
        !canUseHiddenOutputSnapshot(transport.getPtyId())
      ) {
        return false
      }
      // Why: CPR/DECRQM replies depend on ordered terminal state. Keep the rare
      // clean stateful-query chunk live; after skipped bytes, avoid stale replies.
      return hiddenRendererStateDirty || !containsStatefulRendererQuery(data)
    }

    function writeHiddenStartupRendererQueries(data: string): void {
      const extracted = extractHiddenStartupRendererQueryData(
        data,
        hiddenStartupRendererQueryPending
      )
      hiddenStartupRendererQueryPending = extracted.pending
      if (extracted.oscColorQueryData) {
        // Why: Codex's startup palette probe has a 100 ms budget. Answer
        // hidden color queries directly and immediately so neither renderer
        // scheduling nor the remote input debounce (#7329) can miss it.
        sendTerminalOscColorQueryReplies(
          extracted.oscColorQueryData,
          pane.terminal,
          sendDesktopQueryReplyImmediate
        )
      }
      if (extracted.statelessQueryData) {
        writePtyOutputToXterm(extracted.statelessQueryData, false, {
          hiddenStartupRendererQuery: true
        })
      }
      // Stateful hidden queries require ordered terminal state. If this pane's
      // hidden xterm is dirty, skipping is safer than sending stale CPR/DECRQM.
    }

    function takeHiddenStartupRendererQueryPendingForForeground(data: string): {
      statelessQueryData: string
      statefulQueryData: string
      oscColorQueryData: string
      remainingData: string
      consumedCurrentChars: number
    } {
      const pending = hiddenStartupRendererQueryPending
      hiddenStartupRendererQueryPending = ''
      if (!pending) {
        return {
          statelessQueryData: '',
          statefulQueryData: '',
          oscColorQueryData: '',
          remainingData: data,
          consumedCurrentChars: 0
        }
      }

      const input = pending + data
      let statelessQueryData = ''
      let statefulQueryData = ''
      let oscColorQueryData = ''
      let consumedInputChars = pending.length
      let nextPending = ''
      if (input.startsWith('\x1b[')) {
        const finalByteIndex = findCsiFinalByteIndex(input, 2)
        if (finalByteIndex === -1) {
          nextPending = input.slice(0, HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS)
          consumedInputChars = input.length
        } else {
          const sequence = input.slice(0, finalByteIndex + 1)
          if (isStatelessRendererReplyCsiQuery(sequence)) {
            statelessQueryData = sequence
          } else if (isStatefulRendererReplyCsiQuery(sequence)) {
            statefulQueryData = sequence
          }
          consumedInputChars = finalByteIndex + 1
        }
      } else if (input.startsWith('\x1b]')) {
        const query = parseTerminalOscColorQuery(input, 0)
        if (query.kind === 'partial') {
          nextPending = input.slice(0, HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS)
          consumedInputChars = input.length
        } else if (query.kind === 'match') {
          oscColorQueryData = input.slice(0, query.endIndex)
          consumedInputChars = query.endIndex
        } else {
          consumedInputChars = pending.length
        }
      } else if (input.length === 1) {
        nextPending = input
        consumedInputChars = input.length
      } else {
        consumedInputChars = pending.length
      }

      hiddenStartupRendererQueryPending = nextPending
      const consumedCurrentChars = Math.max(0, consumedInputChars - pending.length)
      return {
        statelessQueryData,
        statefulQueryData,
        oscColorQueryData,
        remainingData: data.slice(consumedCurrentChars),
        consumedCurrentChars
      }
    }

    function metaAfterConsumingCurrentChars(
      meta: PtyDataMeta | undefined,
      consumedCurrentChars: number
    ): PtyDataMeta | undefined {
      if (consumedCurrentChars === 0 || typeof meta?.rawLength !== 'number') {
        return meta
      }
      return {
        ...meta,
        rawLength: Math.max(0, meta.rawLength - consumedCurrentChars)
      }
    }

    function skipHiddenRendererOutput(data: string): void {
      writeHiddenStartupRendererQueries(data)
      respondToSkippedMode2031Subscribe(data)
      markHiddenOutputRestoreNeeded()
      hiddenRendererStateDirty = true
      if (hiddenOutputRestoreInFlight) {
        hiddenOutputRestoreFreshSnapshotNeeded = true
      }
      recordHiddenRendererSkip(data.length)
    }

    // Why: discarding queued flood bytes must never swallow terminal queries —
    // a lost DSR/CPR (or color/DA) reply hangs the querying program (the bench
    // DSR timeout). The discarded CONTENT is owned by the snapshot repaint.
    // Replies are synthesized through the immediate input path instead of
    // replaying the queries into xterm: a drop always triggers a snapshot
    // restore, whose replay guard swallows xterm auto-replies and whose
    // discardTerminalOutput races away queued query writes — both killed the
    // salvaged reply in practice. Only called for bytes being thrown away, so
    // replies cannot double-fire against a later queue drain.
    function salvageRendererQueriesFromDiscardedRestoreData(data: string): void {
      if (!data || !data.includes('\x1b')) {
        return
      }
      const extracted = extractHiddenStartupRendererQueryData(data, '')
      if (extracted.oscColorQueryData) {
        sendTerminalOscColorQueryReplies(
          extracted.oscColorQueryData,
          pane.terminal,
          sendDesktopQueryReplyImmediate
        )
      }
      let unansweredQueryData = ''
      for (const sequence of splitCsiSequences(
        extracted.statefulQueryData + extracted.statelessQueryData
      )) {
        if (sequence === '\x1b[6n') {
          // CPR from the live buffer. Position may be mid-repaint stale — in a
          // drop scenario positional accuracy is already forfeit; liveness is
          // the contract (a blocked reader must unblock).
          const buffer = pane.terminal.buffer.active
          const row = Math.min(buffer.cursorY + 1, pane.terminal.rows)
          const col = Math.min(buffer.cursorX + 1, pane.terminal.cols)
          sendDesktopQueryReplyImmediate(`\x1b[${row};${col}R`)
        } else if (sequence === '\x1b[c' || sequence === '\x1b[0c') {
          sendDesktopQueryReplyImmediate(DEFAULT_DA1_RESPONSE)
        } else {
          unansweredQueryData += sequence
        }
      }
      if (unansweredQueryData) {
        // Best-effort for the rarer queries (DECRQM, DA2, XTVERSION): replay
        // into xterm and let its handlers answer when no replay is active.
        writePtyOutputToXterm(unansweredQueryData, true, { hiddenStartupRendererQuery: true })
      }
    }

    function splitCsiSequences(queryData: string): string[] {
      const sequences: string[] = []
      let offset = queryData.indexOf('\x1b[')
      while (offset !== -1) {
        const finalByteIndex = findCsiFinalByteIndex(queryData, offset + 2)
        if (finalByteIndex === -1) {
          break
        }
        sequences.push(queryData.slice(offset, finalByteIndex + 1))
        offset = queryData.indexOf('\x1b[', finalByteIndex + 1)
      }
      return sequences
    }

    function queueLiveChunkDuringRestore(data: string, meta?: PtyDataMeta): void {
      if (!data) {
        return
      }
      const ptyId = transport.getPtyId()
      if (!canUseHiddenOutputSnapshot(ptyId)) {
        return
      }
      if (hiddenOutputRestorePtyId !== null && hiddenOutputRestorePtyId !== ptyId) {
        clearHiddenOutputRestoreState()
      }
      hiddenOutputRestorePtyId = ptyId
      hiddenOutputRestoreNeeded = true
      if (hiddenOutputRestorePendingOverflow) {
        // Why: the overflow latch means everything queued gets discarded at the
        // next drain — queueing more only grows the discard. Salvage queries,
        // drop the content.
        salvageRendererQueriesFromDiscardedRestoreData(data)
        armHiddenOutputRestoreForegroundDeadline()
        return
      }
      if (hiddenOutputRestorePendingChars + data.length > HIDDEN_OUTPUT_RESTORE_PENDING_CHARS) {
        const discardedChunks = hiddenOutputRestorePendingChunks
        hiddenOutputRestorePendingChunks = []
        hiddenOutputRestorePendingChars = 0
        hiddenOutputRestorePendingOverflow = true
        for (const chunk of discardedChunks) {
          salvageRendererQueriesFromDiscardedRestoreData(chunk.data)
        }
        salvageRendererQueriesFromDiscardedRestoreData(data)
        armHiddenOutputRestoreForegroundDeadline()
        return
      }
      const pending: PendingHiddenOutputRestoreChunk = { data }
      if (typeof meta?.seq === 'number') {
        pending.seq = meta.seq
      }
      if (typeof meta?.rawLength === 'number') {
        pending.rawLength = meta.rawLength
      }
      hiddenOutputRestorePendingChunks.push(pending)
      hiddenOutputRestorePendingChars += data.length
      armHiddenOutputRestoreForegroundDeadline()
    }

    function getChunkDataAfterSnapshot(
      chunk: PendingHiddenOutputRestoreChunk,
      snapshotSeq: number | undefined
    ): string | null {
      if (typeof snapshotSeq !== 'number' || typeof chunk.seq !== 'number') {
        return chunk.data
      }
      const rawLength = chunk.rawLength ?? chunk.data.length
      const startSeq = chunk.seq - rawLength
      if (snapshotSeq >= chunk.seq) {
        return ''
      }
      if (snapshotSeq <= startSeq) {
        return chunk.data
      }
      const offset = snapshotSeq - startSeq
      if (rawLength !== chunk.data.length) {
        return null
      }
      return chunk.data.slice(offset)
    }

    type RestoredSnapshotReconciliation =
      | { action: 'write'; data: string; meta: PtyDataMeta | undefined }
      | { action: 'drop-duplicate' }
      | { action: 'force-fresh-restore' }

    // Why: same slicing rules as getChunkDataAfterSnapshot, applied to LIVE
    // chunks after a restore completed — main's ACK backlog keeps draining
    // chunks at or before the snapshot seq, and pending-cap trims can drop
    // seq ranges silently once the one-shot overflow marker was consumed.
    function reconcileChunkAgainstRestoredSnapshot(
      data: string,
      meta: PtyDataMeta | undefined
    ): RestoredSnapshotReconciliation {
      if (restoredSnapshotBaselineSeq === null) {
        return { action: 'write', data, meta }
      }
      if (transport.getPtyId() !== restoredSnapshotBaselinePtyId) {
        clearRestoredSnapshotBaseline()
        return { action: 'write', data, meta }
      }
      if (typeof meta?.seq !== 'number') {
        // Why: seq-less chunks (no runtime metering) cannot be reconciled;
        // mirror getChunkDataAfterSnapshot and pass them through.
        return { action: 'write', data, meta }
      }
      if (
        restoredSnapshotDeliveryWindowStartSeq !== null &&
        meta.seq <= restoredSnapshotDeliveryWindowStartSeq
      ) {
        // Why: every byte main could still deliver at snapshot time started
        // AFTER this seq, and delivery is once-and-in-order — so this chunk
        // cannot be a backlog duplicate. It is a new seq domain (restarted
        // counter / synthetic source); retire the stale baseline and write
        // instead of silently dropping genuinely-new live output.
        clearRestoredSnapshotBaseline()
        return { action: 'write', data, meta }
      }
      const rawLength = meta.rawLength ?? data.length
      const startSeq = meta.seq - rawLength
      const expectedStartSeq = restoredSnapshotExpectedStartSeq
      restoredSnapshotExpectedStartSeq = Math.max(expectedStartSeq ?? meta.seq, meta.seq)
      if (expectedStartSeq !== null && startSeq > expectedStartSeq) {
        // Why: the chunk starts past the continuity point — bytes between
        // were dropped (pending-cap trim after the marker fired). Only the
        // model snapshot can heal the gap.
        return { action: 'force-fresh-restore' }
      }
      if (meta.seq <= restoredSnapshotBaselineSeq) {
        return { action: 'drop-duplicate' }
      }
      if (startSeq >= restoredSnapshotBaselineSeq) {
        return { action: 'write', data, meta }
      }
      if (rawLength !== data.length) {
        // Why: renderer-only OSC stripping makes raw sequence offsets
        // impossible to map onto cleaned text — fetch a fresh snapshot
        // instead of risking duplicate visible output.
        return { action: 'force-fresh-restore' }
      }
      const sliced = data.slice(restoredSnapshotBaselineSeq - startSeq)
      return {
        action: 'write',
        data: sliced,
        // Why: keep seq metadata consistent with the sliced payload so a
        // later restore queue drain slices against accurate offsets.
        meta: { ...meta, rawLength: sliced.length }
      }
    }

    function recordRendererOrderedSeq(meta?: Pick<PtyDataMeta, 'seq'>): void {
      if (typeof meta?.seq !== 'number') {
        return
      }
      const ptyId = transport.getPtyId()
      if (!ptyId) {
        return
      }
      if (rendererOrderedPtyId !== ptyId) {
        rendererOrderedPtyId = ptyId
        rendererOrderedSeq = meta.seq
        return
      }
      rendererOrderedSeq = Math.max(rendererOrderedSeq ?? 0, meta.seq)
    }

    resetRendererOrderedSeqForPtyExit = (exitedPtyId: string): void => {
      // Why: an exit ends this ptyId's seq domain. A revived session can reuse
      // the id with a restarted main-side counter, and a stale high-water mark
      // would wrongly cover — and silently drop — every hidden byte it emits.
      // The restored-snapshot baseline is a seq high-water mark too and must
      // die at the same boundary, or reconcile drops revived chunks as
      // duplicates.
      if (restoredSnapshotBaselinePtyId === exitedPtyId) {
        clearRestoredSnapshotBaseline()
      }
      if (rendererOrderedPtyId === exitedPtyId) {
        rendererOrderedPtyId = null
        rendererOrderedSeq = null
      }
      if (rendererChannelSeqPtyId === exitedPtyId) {
        rendererChannelSeqPtyId = null
        rendererChannelSeq = null
      }
    }

    function observeRendererOrderedSeqRegression(meta: PtyDataMeta | undefined): void {
      if (typeof meta?.seq !== 'number') {
        return
      }
      const ptyId = transport.getPtyId()
      if (!ptyId) {
        return
      }
      if (rendererChannelSeqPtyId !== ptyId) {
        rendererChannelSeqPtyId = ptyId
        rendererChannelSeq = meta.seq
        return
      }
      if (rendererChannelSeq !== null && meta.seq < rendererChannelSeq) {
        // Why: pty:data delivery is FIFO per pty, so seq only moves backwards
        // when the session was revived without an observed exit and restarted
        // its counter. Drop the stale ordered baseline instead of letting it
        // cover the new stream's bytes.
        if (rendererOrderedPtyId === ptyId) {
          rendererOrderedPtyId = null
          rendererOrderedSeq = null
        }
      }
      rendererChannelSeq = meta.seq
    }

    function getHiddenRendererDataAfterOrderedSeq(
      data: string,
      meta: PtyDataMeta | undefined
    ): string | null {
      if (
        rendererOrderedPtyId === null ||
        rendererOrderedSeq === null ||
        transport.getPtyId() !== rendererOrderedPtyId
      ) {
        return data
      }
      return getChunkDataAfterSnapshot(
        { data, seq: meta?.seq, rawLength: meta?.rawLength },
        rendererOrderedSeq
      )
    }

    // 'drained' painted every queued live byte; 'overflow' means the queue
    // blew its cap during this restore (the stream is outrunning snapshot
    // fetch+replay); 'refetch' means offsets were unmappable and only a
    // fresher snapshot can realign.
    function drainPendingLiveChunksAfterSnapshot(
      snapshotSeq: number | undefined
    ): 'drained' | 'overflow' | 'refetch' {
      if (hiddenOutputRestorePendingOverflow) {
        hiddenOutputRestorePendingOverflow = false
        discardPendingLiveChunksSalvagingQueries()
        return 'overflow'
      }
      while (hiddenOutputRestorePendingChunks.length > 0) {
        const chunks = hiddenOutputRestorePendingChunks
        hiddenOutputRestorePendingChunks = []
        hiddenOutputRestorePendingChars = 0
        for (const [index, chunk] of chunks.entries()) {
          const data = getChunkDataAfterSnapshot(chunk, snapshotSeq)
          if (data === null) {
            // Why: renderer-only OSC stripping makes raw sequence offsets
            // impossible to map onto cleaned text. Fetch a fresher main
            // snapshot instead of risking duplicate visible output.
            for (const discarded of chunks.slice(index)) {
              salvageRendererQueriesFromDiscardedRestoreData(discarded.data)
            }
            discardPendingLiveChunksSalvagingQueries()
            return 'refetch'
          }
          // Why: drained chunks advance the post-restore continuity point so
          // the live-chunk reconciliation neither re-drops them as duplicates
          // nor misreads the next live chunk as a gap.
          if (typeof chunk.seq === 'number' && restoredSnapshotExpectedStartSeq !== null) {
            restoredSnapshotExpectedStartSeq = Math.max(restoredSnapshotExpectedStartSeq, chunk.seq)
          }
          if (data) {
            writePtyOutputToXterm(data, true)
            recordRendererOrderedSeq(chunk)
          }
        }
        if (hiddenOutputRestorePendingOverflow) {
          hiddenOutputRestorePendingOverflow = false
          discardPendingLiveChunksSalvagingQueries()
          return 'overflow'
        }
      }
      return 'drained'
    }

    function discardPendingLiveChunksSalvagingQueries(): void {
      const discarded = hiddenOutputRestorePendingChunks
      hiddenOutputRestorePendingChunks = []
      hiddenOutputRestorePendingChars = 0
      for (const chunk of discarded) {
        salvageRendererQueriesFromDiscardedRestoreData(chunk.data)
      }
    }

    function clearPendingLiveChunksDuringRestore(): void {
      hiddenOutputRestorePendingChunks = []
      hiddenOutputRestorePendingChars = 0
      hiddenOutputRestorePendingOverflow = false
      hiddenOutputRestoreFreshSnapshotNeeded = false
      hiddenOutputRestoreRetryDeferred = false
      hiddenOutputRestoreScheduled = false
      cancelScheduledHiddenOutputRestore(pane.terminal)
      clearHiddenOutputRestoreDeferredRetryTimer()
      clearHiddenOutputRestoreForegroundDeadlineTimer()
      hiddenOutputRestoreDeferredRetryAttempts = 0
    }

    function clearHiddenOutputRestoreDeferredRetryTimer(): void {
      if (hiddenOutputRestoreDeferredRetryTimer === null) {
        return
      }
      clearTimeout(hiddenOutputRestoreDeferredRetryTimer)
      hiddenOutputRestoreDeferredRetryTimer = null
    }
    cleanupHiddenOutputRestoreDeferredRetry = clearHiddenOutputRestoreDeferredRetryTimer

    function clearHiddenOutputRestoreForegroundDeadlineTimer(): void {
      if (hiddenOutputRestoreForegroundDeadlineTimer === null) {
        return
      }
      clearTimeout(hiddenOutputRestoreForegroundDeadlineTimer)
      hiddenOutputRestoreForegroundDeadlineTimer = null
    }
    cleanupHiddenOutputRestoreForegroundDeadline = clearHiddenOutputRestoreForegroundDeadlineTimer

    function armHiddenOutputRestoreForegroundDeadline(): void {
      if (
        disposed ||
        hiddenOutputRestoreForegroundDeadlineTimer !== null ||
        !shouldWritePtyOutputForeground(deps.isVisibleRef.current) ||
        (hiddenOutputRestorePendingChunks.length === 0 && !hiddenOutputRestorePendingOverflow)
      ) {
        return
      }
      const ptyId = hiddenOutputRestorePtyId
      if (ptyId === null || transport.getPtyId() !== ptyId) {
        return
      }
      const deadlineGeneration = hiddenOutputRestoreGeneration
      // Why: only foreground-visible output blocked behind recovery gets a
      // deadline; hidden-time restore work can continue without user impact.
      hiddenOutputRestoreForegroundDeadlineTimer = setTimeout(() => {
        hiddenOutputRestoreForegroundDeadlineTimer = null
        if (
          disposed ||
          hiddenOutputRestoreGeneration !== deadlineGeneration ||
          hiddenOutputRestorePtyId !== ptyId ||
          !shouldWritePtyOutputForeground(deps.isVisibleRef.current)
        ) {
          return
        }
        abandonHiddenOutputRestoreAndDrainPendingForeground(ptyId)
      }, HIDDEN_OUTPUT_RESTORE_FOREGROUND_TIMEOUT_MS)
    }

    function abandonHiddenOutputRestoreAndDrainPendingForeground(
      expectedPtyId: string,
      opts: { quiet?: boolean } = {}
    ): void {
      if (transport.getPtyId() !== expectedPtyId || hiddenOutputRestorePtyId !== expectedPtyId) {
        resetHiddenOutputRestoreIfPtyChanged()
        return
      }
      const pendingChunks = hiddenOutputRestorePendingOverflow
        ? []
        : hiddenOutputRestorePendingChunks.slice()
      const hadPendingOverflow = hiddenOutputRestorePendingOverflow
      const replayingSnapshot = hiddenOutputRestoreReplayingSnapshot
      hiddenOutputRestoreReplayingSnapshot = null
      hiddenOutputRestoreGeneration += 1
      if (
        hiddenOutputSnapshotScrollRestore?.valid &&
        hiddenOutputSnapshotScrollRestore.ptyId === expectedPtyId
      ) {
        // Why: same-PTY flood abandonment stops recovery bookkeeping, but its
        // already-queued replay must keep the rebuild bracket and final pin.
        hiddenOutputSnapshotScrollRestore.generation = hiddenOutputRestoreGeneration
      }
      hiddenOutputRestoreInFlight = null
      hiddenOutputRestoreNeeded = false
      hiddenOutputRestorePtyId = null
      hiddenOutputRestorePendingChunks = []
      hiddenOutputRestorePendingChars = 0
      hiddenOutputRestorePendingOverflow = false
      hiddenOutputRestoreFreshSnapshotNeeded = false
      hiddenOutputRestoreRetryDeferred = false
      hiddenOutputRestoreScheduled = false
      hiddenStartupRendererQueryPending = ''
      hiddenRendererStateDirty = false
      resetHiddenRendererRiskState()
      cancelScheduledHiddenOutputRestore(pane.terminal)
      clearHiddenOutputRestoreDeferredRetryTimer()
      clearHiddenOutputRestoreForegroundDeadlineTimer()
      hiddenOutputRestoreDeferredRetryAttempts = 0

      // Why quiet exists: flood cuts abandon deliberately and schedule a
      // post-flood repaint — the "restore unavailable" warning would be
      // misleading noise the repaint immediately wipes.
      if (!opts.quiet) {
        writeRestoreUnavailableWarning()
      }
      if (hadPendingOverflow) {
        return
      }
      const replayedSeq = typeof replayingSnapshot?.seq === 'number' ? replayingSnapshot.seq : null
      let pendingData = ''
      for (const chunk of pendingChunks) {
        const sliced =
          replayedSeq === null ? chunk.data : getChunkDataAfterSnapshot(chunk, replayedSeq)
        pendingData += sliced ?? chunk.data
      }
      if (replayingSnapshot && replayedSeq !== null) {
        setRestoredSnapshotBaseline(expectedPtyId, replayingSnapshot)
        for (const chunk of pendingChunks) {
          if (typeof chunk.seq === 'number' && restoredSnapshotExpectedStartSeq !== null) {
            restoredSnapshotExpectedStartSeq = Math.max(restoredSnapshotExpectedStartSeq, chunk.seq)
          }
        }
      }
      if (pendingData) {
        writePtyOutputToXterm(pendingData, true)
      }
    }

    function scheduleHiddenOutputRestoreDeferredRetry(): void {
      if (
        disposed ||
        hiddenOutputRestoreDeferredRetryTimer !== null ||
        !shouldWritePtyOutputForeground(deps.isVisibleRef.current)
      ) {
        return
      }
      if (hiddenOutputRestoreDeferredRetryAttempts >= HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MAX) {
        const ptyId = hiddenOutputRestorePtyId
        if (ptyId !== null) {
          abandonHiddenOutputRestoreAndDrainPendingForeground(ptyId)
        } else {
          clearHiddenOutputRestoreState()
          writeRestoreUnavailableWarning()
        }
        return
      }
      hiddenOutputRestoreDeferredRetryAttempts += 1
      // Why: null requested snapshots usually mean remote output was still
      // mutating. Retry after one quiet tick instead of spinning synchronously.
      hiddenOutputRestoreDeferredRetryTimer = setTimeout(() => {
        hiddenOutputRestoreDeferredRetryTimer = null
        if (disposed || !hiddenOutputRestoreNeeded) {
          return
        }
        hiddenOutputRestoreRetryDeferred = false
        requestHiddenOutputRestoreIfNeeded()
      }, HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MS)
    }

    function clearHiddenOutputRestoreState(): void {
      cancelSnapshotScrollRestore()
      clearPendingLiveChunksDuringRestore()
      hiddenStartupRendererQueryPending = ''
      hiddenRendererStateDirty = false
      resetHiddenRendererRiskState()
      hiddenOutputRestoreNeeded = false
      hiddenOutputRestorePtyId = null
      hiddenOutputRestoreReplayingSnapshot = null
      hiddenOutputRestoreGeneration += 1
    }

    function cancelSnapshotScrollRestore(): void {
      pendingHiddenSnapshotFit?.cancel()
      pendingHiddenSnapshotFit = null
      const scrollRestore = hiddenOutputSnapshotScrollRestore
      if (!scrollRestore) {
        return
      }
      scrollRestore.valid = false
      hiddenOutputSnapshotScrollRestore = null
      if (scrollRestore.started) {
        cancelTerminalScrollIntentBufferRebuildCompletions(pane.terminal)
      }
      // Why: invalidation suppresses restoration, but queued bytes still own
      // the bracket until their FIFO sentinels prove parsing has finished.
    }
    cancelHiddenOutputSnapshotScrollRestore = cancelSnapshotScrollRestore

    function clearPaneMode2031State(): void {
      deps.paneMode2031Ref.current.delete(pane.id)
      deps.paneLastThemeModeRef.current.delete(pane.id)
    }

    function pulseVisibleLocalPtySizeForTuiRepaint(ptyId: string): void {
      if (
        !isRendererPtyResizeAuthoritative() ||
        shouldSuppressDesktopPtyResize() ||
        isRemoteRuntimePtyId(ptyId)
      ) {
        return
      }
      const cols = pane.terminal.cols
      const rows = pane.terminal.rows
      if (cols <= 2 || rows <= 0) {
        return
      }
      // Why: a hidden alternate-screen TUI can miss the same-size restore
      // SIGWINCH. A one-column pulse makes the repaint observable to the child.
      transport.resize(cols - 1, rows)
      transport.resize(cols, rows)
    }

    function skipBackgroundAlternateScreenOutput(data: string): void {
      writeHiddenStartupRendererQueries(data)
      respondToSkippedMode2031Subscribe(data)
      resetSkippedHiddenRendererRiskState()
      hiddenRendererStateDirty = true
      recordHiddenRendererSkip(data.length)
      const ptyId = transport.getPtyId()
      if (!ptyId || alternateScreenBackgroundRepaintTimer !== null) {
        return
      }
      pulseVisibleLocalPtySizeForTuiRepaint(ptyId)
      alternateScreenBackgroundRepaintTimer = setTimeout(() => {
        alternateScreenBackgroundRepaintTimer = null
      }, 100)
    }

    function resetHiddenOutputRestoreIfPtyChanged(): void {
      if (hiddenOutputRestorePtyId === null) {
        return
      }
      if (transport.getPtyId() !== hiddenOutputRestorePtyId) {
        // Why: renderer backlog is tied to the old PTY stream; after reattach,
        // queued hidden bytes must not delay or replay before the new PTY.
        clearHiddenOutputRestoreState()
        clearRestoredSnapshotBaseline()
        clearPaneMode2031State()
        // Why: flood-backpressure evidence is per PTY stream too.
        resetHiddenOutputRestoreFloodSuppression()
        discardTerminalOutput(pane.terminal)
      }
    }

    function writeRestoreUnavailableWarning(): void {
      if (!shouldWritePtyOutputForeground(deps.isVisibleRef.current)) {
        return
      }
      writeTerminalOutput(pane.terminal, HIDDEN_OUTPUT_RESTORE_UNAVAILABLE_WARNING, {
        foreground: true,
        beforeWrite: beforeTerminalOutputWrite
      })
    }

    async function applyMainBufferSnapshot(snapshot: {
      data: string
      cols: number
      rows: number
      seq?: number
      pendingDeliveryStartSeq?: number
      alternateScreen?: boolean
      scrollbackAnsi?: string
      pendingEscapeTailAnsi?: string
    }): Promise<void> {
      const restorePtyId = transport.getPtyId()
      const restoreGeneration = hiddenOutputRestoreGeneration
      if (hiddenOutputSnapshotScrollRestore) {
        cancelSnapshotScrollRestore()
      }
      const scrollRestore = {
        ptyId: restorePtyId,
        generation: restoreGeneration,
        valid: true,
        started: false
      }
      hiddenOutputSnapshotScrollRestore = scrollRestore
      const colsBeforeReplay = pane.terminal.cols
      const rowsBeforeReplay = pane.terminal.rows
      const hasSnapshotDimensions =
        Number.isFinite(snapshot.cols) &&
        Number.isFinite(snapshot.rows) &&
        snapshot.cols > 0 &&
        snapshot.rows > 0
      try {
        await structuralReplayCoordinator.run(
          async () => {
            if (
              !scrollRestore.valid ||
              disposed ||
              transport.getPtyId() !== scrollRestore.ptyId ||
              hiddenOutputRestoreGeneration !== scrollRestore.generation
            ) {
              return
            }
            scrollRestore.started = true
            if (typeof snapshot.seq === 'number') {
              hiddenOutputRestoreReplayingSnapshot = {
                seq: snapshot.seq,
                ...(typeof snapshot.pendingDeliveryStartSeq === 'number'
                  ? { pendingDeliveryStartSeq: snapshot.pendingDeliveryStartSeq }
                  : {})
              }
            }
            discardTerminalOutput(pane.terminal)
            if (
              hasSnapshotDimensions &&
              (pane.terminal.cols !== snapshot.cols || pane.terminal.rows !== snapshot.rows)
            ) {
              // Why: xterm parses writes later. Keep snapshot dimensions until
              // the FIFO sentinel completes so serialized wraps stay exact.
              suppressStructuralReplayPtyResize = true
              try {
                pane.terminal.resize(snapshot.cols, snapshot.rows)
              } finally {
                suppressStructuralReplayPtyResize = false
              }
            }
            if (!snapshot.alternateScreen) {
              // Why: this clear (incl. \x1b[3J) wipes xterm's scrollback. Alt-screen
              // TUIs (Claude Code, vim) keep their scroll history in xterm, so
              // clearing on restore loses scroll-up after a hidden->visible return.
              // Mirrors the attach-time guard in pty-transport.ts.
              writeReplayData('\x1b[2J\x1b[3J\x1b[H')
            } else if (snapshot.scrollbackAnsi !== undefined) {
              // Why: SerializeAddon captures normal and alternate buffers together.
              // Rebuild normal while it is active, then return to a clean alt frame.
              writeReplayData('\x1b[?1049l\x1b[2J\x1b[3J\x1b[H')
              writeReplayData(snapshot.scrollbackAnsi)
              writeReplayData('\x1b[0m\x1b[?1049h\x1b[2J\x1b[H')
            } else {
              // Why: the snapshot's own ?1049h is a no-op when the pane is already on
              // the alternate screen, and the serialized frame skips blank cells — so
              // without clearing the alt screen the pre-hide frame bleeds through
              // every cell the final frame leaves blank. \x1b[2J on the alt buffer
              // does not touch the normal buffer's scrollback the TUI returns to.
              writeReplayData('\x1b[0m\x1b[?1049h\x1b[2J\x1b[H')
            }
            writeReplayData(snapshot.data)
            // Why: status/title-corroborated live agents own ?25l/?1004h (a forced
            // ?1004l here would silence focus events until the agent restarts, since
            // agents only enable focus reporting at startup).
            writeReplayData(
              hasLiveAgentReattachStatusOrTitleSignal()
                ? POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET
                : POST_REPLAY_LIVE_SNAPSHOT_RESET
            )
            if (snapshot.pendingEscapeTailAnsi) {
              // Why last: the snapshot was taken with main's emulator mid-escape;
              // re-arming the dangling sequence must be the FINAL replay write (any
              // later ESC — including the reset above — aborts it) so the racing
              // live tail's continuation completes it exactly as live, instead of
              // rendering literally (Bug E fix / #7329).
              writeReplayData(snapshot.pendingEscapeTailAnsi)
            }
            hiddenRendererStateDirty = false
            recordRendererOrderedSeq(snapshot)
            resetHiddenRendererRiskState()
            recordTerminalOutput(pane.terminal)
            await waitForTerminalReplayWritesParsed(pane.terminal)
          },
          {
            shouldRestore: () =>
              scrollRestore.valid &&
              !disposed &&
              transport.getPtyId() === scrollRestore.ptyId &&
              hiddenOutputRestoreGeneration === scrollRestore.generation,
            afterRestore: async () => {
              const isCurrentRestore = (): boolean =>
                scrollRestore.valid &&
                !disposed &&
                transport.getPtyId() === scrollRestore.ptyId &&
                hiddenOutputRestoreGeneration === scrollRestore.generation
              if (!isCurrentRestore()) {
                return
              }
              const currentPtyId = transport.getPtyId()
              if (!currentPtyId || getFitOverrideForPty(currentPtyId)) {
                return
              }
              const fit = safeFitAndThen(
                pane,
                'hidden-snapshot-pty-resize',
                () => {
                  if (!isCurrentRestore() || transport.getPtyId() !== currentPtyId) {
                    return
                  }
                  const replayChangedDimensions = hasSnapshotDimensions
                    ? pane.terminal.cols !== snapshot.cols || pane.terminal.rows !== snapshot.rows
                    : pane.terminal.cols !== colsBeforeReplay ||
                      pane.terminal.rows !== rowsBeforeReplay
                  if (replayChangedDimensions && isRendererPtyResizeAuthoritative()) {
                    transport.resize(pane.terminal.cols, pane.terminal.rows)
                    if (!isRemoteRuntimePtyId(currentPtyId)) {
                      // Why: redundant SIGWINCH can make alternate-screen TUIs rebuild
                      // their internal scroll viewport to the top on tab return.
                      window.api.pty.signal(currentPtyId, 'SIGWINCH')
                    }
                  }
                },
                { shouldContinue: isCurrentRestore, retryIfUnmeasurable: true }
              )
              pendingHiddenSnapshotFit = fit
              try {
                await fit.completion
              } finally {
                if (pendingHiddenSnapshotFit === fit) {
                  pendingHiddenSnapshotFit = null
                }
              }
              if (isCurrentRestore()) {
                scheduleReattachIdleAgentCursorReset()
              }
            }
          }
        )
      } finally {
        if (hiddenOutputSnapshotScrollRestore === scrollRestore) {
          hiddenOutputSnapshotScrollRestore = null
        }
      }
    }

    function requestHiddenOutputRestoreIfNeeded(opts?: { bypassScheduler?: boolean }): boolean {
      // Why: once the write pipeline is probe-certified dead, a restore can
      // never parse — replaying just re-arms the wedged breadcrumb drip and
      // wastes a snapshot fetch each time the delivery watchdog heals stuck
      // in-flight bytes (~60s while idle). Recovery owns the pane now; the
      // remounted pane gets a fresh xterm and a fresh restore.
      if (isTerminalWritePipelineCertifiedDead(pane.terminal)) {
        // Why the re-kick: certification's own recovery request can be
        // budget-declined (or its scheduled retry cancelled by a sibling
        // pane's remount). Without a fallback here, a revealed dead pane
        // skips its restore forever and keeps the stale pre-death frame.
        if (!certifiedDeadRestoreRecoveryRequested && !disposed) {
          certifiedDeadRestoreRecoveryRequested = true
          const storePtyId = useAppStore.getState().ptyIdsByTabId?.[deps.tabId]?.[0] ?? null
          void requestTerminalPaneRecovery({
            tabId: deps.tabId,
            ptyId: transport.getPtyId() ?? storePtyId,
            reason: 'restore-blocked',
            terminalRecoveryGeneration,
            terminalRecoveryInstanceId: terminalRecoveryInstance.id
          })
        }
        return false
      }
      resetHiddenOutputRestoreIfPtyChanged()
      const ptyId = hiddenOutputRestorePtyId ?? transport.getPtyId()
      if (!hiddenOutputRestoreNeeded && hiddenOutputRestorePendingChunks.length === 0) {
        return false
      }
      if (!canUseHiddenOutputSnapshot(ptyId)) {
        return false
      }
      hiddenOutputRestorePtyId = ptyId
      if (hiddenOutputRestoreInFlight) {
        armHiddenOutputRestoreForegroundDeadline()
        return true
      }
      if (!opts?.bypassScheduler) {
        const priority = isActiveSplitPane() ? 'active' : 'inactive'
        if (priority === 'inactive') {
          if (!hiddenOutputRestoreScheduled) {
            hiddenOutputRestoreScheduled = true
            const scheduledPtyId = ptyId
            const scheduledGeneration = hiddenOutputRestoreGeneration
            // Why: tab/worktree resume can make many split panes visible at once.
            // Restore the focused pane immediately and spread inactive replays
            // across frames so xterm scrollback replay does not block return.
            scheduleHiddenOutputRestore(
              pane.terminal,
              () => {
                hiddenOutputRestoreScheduled = false
                if (
                  disposed ||
                  hiddenOutputRestoreGeneration !== scheduledGeneration ||
                  hiddenOutputRestorePtyId !== scheduledPtyId ||
                  transport.getPtyId() !== scheduledPtyId ||
                  !canUseHiddenOutputSnapshot(scheduledPtyId) ||
                  (!hiddenOutputRestoreNeeded && hiddenOutputRestorePendingChunks.length === 0) ||
                  !shouldWritePtyOutputForeground(deps.isVisibleRef.current)
                ) {
                  return
                }
                requestHiddenOutputRestoreIfNeeded({ bypassScheduler: true })
              },
              priority
            )
          }
          return true
        }
        cancelScheduledHiddenOutputRestore(pane.terminal)
        hiddenOutputRestoreScheduled = false
      }
      clearHiddenOutputRestoreDeferredRetryTimer()
      hiddenOutputRestoreRetryDeferred = false

      hiddenOutputRestoreInFlight = (async () => {
        // Backstop for the rc.7.perf feedback loop: bound how many snapshot
        // fetch+replay rounds one task may burn before it must yield to the
        // live stream.
        let restoreIterations = 0
        while (!disposed) {
          const currentPtyId = hiddenOutputRestorePtyId
          if (currentPtyId === null) {
            clearHiddenOutputRestoreState()
            return
          }
          if (!canUseHiddenOutputSnapshot(currentPtyId)) {
            if (hiddenOutputRestorePtyId === currentPtyId) {
              clearHiddenOutputRestoreState()
            }
            writeRestoreUnavailableWarning()
            return
          }
          if (transport.getPtyId() !== currentPtyId) {
            if (hiddenOutputRestorePtyId === currentPtyId) {
              clearHiddenOutputRestoreState()
            }
            return
          }
          const restoreGeneration = hiddenOutputRestoreGeneration
          hiddenOutputRestoreNeeded = false
          let snapshot: PtyBufferSnapshot | null = null
          try {
            snapshot = await serializeHiddenOutputSnapshot(currentPtyId, {
              scrollbackRows: resolveHiddenRestoreScrollbackRows(pane.terminal.options.scrollback)
            })
          } catch {
            snapshot = null
          }
          if (disposed) {
            return
          }
          const restoreGenerationChanged = hiddenOutputRestoreGeneration !== restoreGeneration
          const restorePtyChanged =
            transport.getPtyId() !== currentPtyId || hiddenOutputRestorePtyId !== currentPtyId
          if (restoreGenerationChanged || restorePtyChanged) {
            // Why: the snapshot belongs to the requested PTY; after reattach,
            // replaying it would show stale/cleared output in the new terminal.
            // A stale generation may be an abandoned timeout while a newer
            // restore for the same PTY owns the current hidden-recovery state.
            if (restorePtyChanged && hiddenOutputRestorePtyId === currentPtyId) {
              clearHiddenOutputRestoreState()
            }
            return
          }
          if (!snapshot) {
            hiddenOutputRestoreNeeded = true
            hiddenOutputRestoreFreshSnapshotNeeded = false
            hiddenOutputRestoreRetryDeferred = true
            scheduleHiddenOutputRestoreDeferredRetry()
            return
          }
          hiddenOutputRestoreDeferredRetryAttempts = 0
          restoreIterations += 1
          await applyMainBufferSnapshot(snapshot)
          if (
            disposed ||
            hiddenOutputRestoreGeneration !== restoreGeneration ||
            hiddenOutputRestorePtyId !== currentPtyId ||
            transport.getPtyId() !== currentPtyId
          ) {
            return
          }
          // Why: everything at or before snapshot.seq is now painted; chunks
          // still draining from main's ACK backlog below that point are
          // duplicates the dataCallback reconciliation must suppress.
          setRestoredSnapshotBaseline(currentPtyId, snapshot)
          hiddenOutputRestoreReplayingSnapshot = null
          const needsFreshSnapshot = hiddenOutputRestoreFreshSnapshotNeeded
          hiddenOutputRestoreFreshSnapshotNeeded = false
          const drainOutcome = drainPendingLiveChunksAfterSnapshot(snapshot.seq)
          if (drainOutcome === 'drained' && !needsFreshSnapshot) {
            hiddenOutputRestoreNeeded = false
            hiddenOutputRestorePtyId = null
            clearHiddenOutputRestoreForegroundDeadlineTimer()
            return
          }
          if (!shouldWritePtyOutputForeground(deps.isVisibleRef.current)) {
            // Why: hidden bytes that arrived during the snapshot were not kept
            // in renderer memory. Leave recovery pending for the next visible
            // moment instead of looping hidden snapshots in a throttled tab.
            hiddenOutputRestoreNeeded = true
            return
          }
          if (drainOutcome === 'overflow') {
            // Cut 1 of the rc.7.perf feedback loop: a FOREGROUND queue
            // overflow means the live stream outruns snapshot fetch+replay.
            // Re-fetching would starve ACK processing again and feed the
            // drop/re-arm cycle — abandon now, let bytes write through, and
            // heal with one repaint after the flood.
            noteHiddenOutputRestoreFloodBackpressure()
            abandonHiddenOutputRestoreAndDrainPendingForeground(currentPtyId, { quiet: true })
            return
          }
          if (restoreIterations >= HIDDEN_OUTPUT_RESTORE_MAX_LOOP_ITERATIONS) {
            // Backstop: fresh-snapshot marks / unmappable slices re-looping
            // this many times means the stream is winning the race.
            warnTerminalLifecycleAnomaly('hidden output restore hit its iteration cap', {
              tabId: deps.tabId,
              worktreeId: deps.worktreeId,
              leafId: pane.leafId,
              paneId: pane.id,
              ptyId: currentPtyId,
              reason: drainOutcome
            })
            noteHiddenOutputRestoreFloodBackpressure()
            abandonHiddenOutputRestoreAndDrainPendingForeground(currentPtyId, { quiet: true })
            return
          }
          hiddenOutputRestoreNeeded = true
        }
      })()
      const hiddenOutputRestoreTask = hiddenOutputRestoreInFlight
      let trackedHiddenOutputRestore: Promise<void>
      trackedHiddenOutputRestore = hiddenOutputRestoreTask.finally(() => {
        if (hiddenOutputRestoreInFlight === trackedHiddenOutputRestore) {
          hiddenOutputRestoreInFlight = null
        }
        if (hiddenOutputRestorePendingChunks.length > 0 || hiddenOutputRestorePendingOverflow) {
          hiddenOutputRestoreNeeded = true
          armHiddenOutputRestoreForegroundDeadline()
        }
        if (
          !hiddenOutputRestoreRetryDeferred &&
          hiddenOutputRestoreNeeded &&
          shouldWritePtyOutputForeground(deps.isVisibleRef.current)
        ) {
          requestHiddenOutputRestoreIfNeeded()
        }
      })
      hiddenOutputRestoreInFlight = trackedHiddenOutputRestore
      return true
    }

    unregisterBacklogRecovery = registerTerminalBacklogRecovery(pane.terminal, () => {
      // Why: clear the hidden-delivery bit BEFORE the restore snapshot
      // request — bytes arriving between the unhide IPC and the snapshot
      // are reconciled by the existing seq guard.
      syncHiddenRendererPtyDelivery()
      return requestHiddenOutputRestoreIfNeeded()
    })
    if (
      typeof document !== 'undefined' &&
      typeof document.addEventListener === 'function' &&
      typeof document.removeEventListener === 'function'
    ) {
      const onDocumentVisibilityChange = (): void => {
        // Why: document hide/show flips the foreground predicate without any
        // pane lifecycle event — re-sync the hidden-delivery gate both ways.
        syncHiddenRendererPtyDelivery()
        if (shouldWritePtyOutputForeground(deps.isVisibleRef.current)) {
          requestHiddenOutputRestoreIfNeeded()
        }
      }
      document.addEventListener('visibilitychange', onDocumentVisibilityChange)
      // Why: when user input proves visibilityState is wedged at 'hidden'
      // (stale macOS occlusion), run the same resync — no visibilitychange
      // will ever fire in that state, and the gate would drop watched bytes
      // forever.
      const unregisterStaleVisibilityRecovery = registerStaleDocumentVisibilityRecovery(
        onDocumentVisibilityChange
      )
      unregisterDocumentVisibilityRecovery = () => {
        document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
        unregisterStaleVisibilityRecovery()
      }
    }

    const dataCallback = (
      data: string,
      meta?: PtyDataMeta,
      streamGeneration = transportStreamGeneration
    ): void => {
      if (streamGeneration !== transportStreamGeneration) {
        return
      }
      if (deferredReattachLiveData !== null) {
        // Why: a replacement stream must not inherit either bytes or a gap
        // marker from the replay owner it superseded.
        deferredReattachLiveData = deferredReattachLiveData.filter(
          (chunk) => chunk.streamGeneration === streamGeneration
        )
        deferredReattachLiveDataChars = deferredReattachLiveData.reduce(
          (total, chunk) => total + chunk.data.length,
          0
        )
        const oversized = data.length > MAX_DEFERRED_REATTACH_LIVE_CHARS
        const deferredData = oversized ? data.slice(-MAX_DEFERRED_REATTACH_LIVE_CHARS) : data
        deferredReattachLiveData.push({
          data: deferredData,
          ptyId: transport.getPtyId(),
          streamGeneration,
          ...(meta ? { meta } : {})
        })
        deferredReattachLiveDataChars += deferredData.length
        // Why: retaining one arbitrarily large IPC frame would bypass this
        // queue's memory bound. Mark it as a stream gap so snapshot recovery
        // replaces it instead of feeding a partial ANSI frame to xterm.
        let dropped = oversized
        while (
          deferredReattachLiveData.length > 1 &&
          (deferredReattachLiveData.length > MAX_DEFERRED_REATTACH_LIVE_CHUNKS ||
            deferredReattachLiveDataChars > MAX_DEFERRED_REATTACH_LIVE_CHARS)
        ) {
          const removed = deferredReattachLiveData.shift()
          deferredReattachLiveDataChars -= removed?.data.length ?? 0
          dropped = true
        }
        if (dropped && deferredReattachLiveData[0]) {
          deferredReattachLiveData[0].meta = {
            ...deferredReattachLiveData[0].meta,
            droppedOutput: true
          }
        }
        return
      }
      if (data.length > 0) {
        hasReceivedPtyOutput = true
        recordAgentHibernationPaneOutput(cacheKey)
        // Why: output is the agent-start escalation signal that ends the relaxed
        // no-evidence process-scan cadence (a starting agent always prints).
        agentCompletionCoordinator.observeOutputActivity()
      }
      if (sshShellReadyMarkerScan) {
        const scanned = scanForShellReadyMarker(sshShellReadyMarkerScan, data)
        if (scanned.matched) {
          markSshStartupShellReady()
        }
        data = scanned.output
      }
      observeStartupDraftPasteReadiness(data)
      resetHiddenOutputRestoreIfPtyChanged()
      if (meta?.droppedOutput === true) {
        // Why gated (rc.7.perf loop): a visible pane's cap-drop during its own
        // restore is backpressure the restore itself caused — re-arming per
        // sentinel kept the snapshot-fetch loop alive for the whole flood.
        // Defer to one post-flood repaint; any carved-out query bytes riding
        // the sentinel still flow through the normal write path below.
        if (meta?.background !== true && isForegroundRestoreBackpressureContext()) {
          noteHiddenOutputRestoreFloodBackpressure()
        } else {
          // Why: main dropped this PTY's buffered output at the pending cap
          // (renderer was not receiving). The stream has a gap, so repaint the
          // pane from the main-owned buffer snapshot instead of writing on.
          markHiddenOutputRestoreNeeded()
          if (data) {
            // The sentinel can carry query bytes carved out of the bulk drop
            // (extractDroppedPtyQueryBytes in main) — replies must still flow.
            salvageRendererQueriesFromDiscardedRestoreData(data)
          }
          return
        }
      }
      respondToTerminalPixelSizeQueries(data)
      observeTerminalBracketedPasteModeOutput(pane.terminal, data)
      // Why: with main side-effect authority, command-finished, pr-link, and
      // the Command Code scrape arrive as pty:sideEffect facts —
      // byte-scanning here too would double-fire the same policy.
      // Remote-runtime PTYs (and the kill switch off) keep this byte path as
      // their only parser.
      if (!mainSideEffectAuthority) {
        for (const link of observeTerminalGitHubPRLink(data)) {
          useAppStore.getState().observeTerminalGitHubPullRequestLink(deps.worktreeId, link)
        }
        commandLifecycle.handlePtyData(data)
      }
      commandCodeOutputStatusDetector?.observe(data)
      // Why: split-pane layouts have multiple visible-but-inactive panes whose
      // output the user is watching. Throttle only when the pane or whole
      // Electron document is hidden.
      const foreground =
        shouldWritePtyOutputForeground(deps.isVisibleRef.current) && meta?.background !== true
      // Why: latch the hidden-delivery gate from the byte path too — covers a
      // PTY id arriving after the initial sync. No-op when state is current.
      if (!foreground) {
        syncHiddenRendererPtyDelivery()
      }
      if (foreground && hiddenMode2031ScanTail) {
        respondToSkippedMode2031Subscribe(data)
      }
      // Why: post-restore reconciliation — drop/slice backlog chunks the
      // restored snapshot already covers, and force a fresh restore for seq
      // gaps or overlaps whose offsets cannot be mapped. Runs after the byte
      // observers above (those bytes were never delivered before; their side
      // effects are still real) but before any xterm write decision.
      const reconciliation = reconcileChunkAgainstRestoredSnapshot(data, meta)
      if (reconciliation.action === 'drop-duplicate') {
        return
      }
      if (reconciliation.action === 'force-fresh-restore') {
        // Why gated (rc.7.perf loop): during a foreground flood the seq gaps
        // come from our own backpressure drops — fetching a snapshot per gap
        // IS the feedback loop. Retire the stale baseline, write the post-gap
        // bytes through, and heal with one repaint after the flood.
        if (foreground && isForegroundRestoreBackpressureContext()) {
          noteHiddenOutputRestoreFloodBackpressure()
          clearRestoredSnapshotBaseline()
          // fall through with the ORIGINAL data/meta — post-gap bytes are new
        } else {
          // Why: in-flight captured BEFORE the mark — on a visible pane the
          // mark starts the restore synchronously and must not flag itself.
          const restoreWasInFlight = hiddenOutputRestoreInFlight !== null
          markHiddenOutputRestoreNeeded()
          if (restoreWasInFlight) {
            hiddenOutputRestoreFreshSnapshotNeeded = true
          }
          return
        }
      } else {
        data = reconciliation.data
        meta = reconciliation.meta
      }
      // Why: a hidden Codex query can be split just before visibility changes;
      // xterm needs the completed query, while other bytes still follow restore.
      const pendingForegroundQuery = foreground
        ? takeHiddenStartupRendererQueryPendingForForeground(data)
        : null
      const rendererData = pendingForegroundQuery?.remainingData ?? data
      const rendererMeta = metaAfterConsumingCurrentChars(
        meta,
        pendingForegroundQuery?.consumedCurrentChars ?? 0
      )
      observeRendererOrderedSeqRegression(meta)
      const orderedRendererData = foreground
        ? rendererData
        : getHiddenRendererDataAfterOrderedSeq(rendererData, rendererMeta)
      if (orderedRendererData === null) {
        // Why: renderer-side filtering cannot map cleaned text back onto raw
        // sequence offsets. Rebuild from main instead of risking stale bytes.
        markHiddenOutputRestoreNeeded()
        schedulePendingStartupCommandDelivery()
        return
      }
      if (!foreground && orderedRendererData.length === 0) {
        recordRendererOrderedSeq(rendererMeta)
        schedulePendingStartupCommandDelivery()
        return
      }
      if (pendingForegroundQuery?.statelessQueryData) {
        writePtyOutputToXterm(pendingForegroundQuery.statelessQueryData, true, {
          hiddenStartupRendererQuery: true
        })
      }
      if (pendingForegroundQuery?.oscColorQueryData) {
        sendTerminalOscColorQueryReplies(
          pendingForegroundQuery.oscColorQueryData,
          pane.terminal,
          // Why: OSC color reply — immediate so the remote debounce cannot delay
          // it past the querying program's read window (#7329).
          sendDesktopQueryReplyImmediate
        )
      }
      const restoreAppliesToCurrentPty =
        hiddenOutputRestorePtyId !== null && transport.getPtyId() === hiddenOutputRestorePtyId
      const skipBackgroundAlternateScreenFrame =
        meta?.background === true &&
        shouldWritePtyOutputForeground(deps.isVisibleRef.current) &&
        pane.terminal.buffer.active.type === 'alternate' &&
        !containsStatefulRendererQuery(orderedRendererData)
      if (skipBackgroundAlternateScreenFrame) {
        skipBackgroundAlternateScreenOutput(orderedRendererData)
      } else if (shouldSkipHiddenRendererOutput(foreground, orderedRendererData)) {
        skipHiddenRendererOutput(orderedRendererData)
      } else if (
        (hiddenOutputRestoreNeeded || hiddenOutputRestoreInFlight) &&
        restoreAppliesToCurrentPty
      ) {
        if (foreground) {
          if (pendingForegroundQuery?.statefulQueryData) {
            queueLiveChunkDuringRestore(pendingForegroundQuery.statefulQueryData)
          }
          queueLiveChunkDuringRestore(orderedRendererData, rendererMeta)
          requestHiddenOutputRestoreIfNeeded()
        } else if (hiddenOutputRestoreInFlight) {
          resetSkippedHiddenRendererRiskState()
          hiddenOutputRestoreNeeded = true
          hiddenOutputRestoreFreshSnapshotNeeded = true
        }
        // Why: hidden chunks with a restore already latched are dropped here —
        // the model snapshot fetched on reveal covers their bytes.
      } else {
        // Why: gate-managed hidden panes normally receive no bytes (main
        // drops after model ingestion). Any hidden chunk that still arrives
        // (kill switch off, interest-held delivery) rides the bounded
        // background scheduler queue; on overflow the scheduler latches the
        // model restore. The kill-switch-off startup-query grammar above is
        // the byte-identical fallback.
        if (pendingForegroundQuery?.statefulQueryData) {
          writePtyOutputToXterm(pendingForegroundQuery.statefulQueryData, true, {
            hiddenStartupRendererQuery: true
          })
        }
        writePtyOutputToXterm(orderedRendererData, foreground)
        if (foreground) {
          recordRendererOrderedSeq(rendererMeta)
        }
      }

      schedulePendingStartupCommandDelivery()
    }
    unregisterE2ePtyDataInjection = registerE2eTerminalPtyDataInjection(cacheKey, (data, meta) => {
      if (!disposed) {
        dataCallback(data, meta)
      }
    })

    const beginReattachLiveDataDeferral = (ownerGeneration = transportStreamGeneration): void => {
      reattachLiveDataDeferralDepth += 1
      if (reattachLiveDataDeferralDepth === 1) {
        deferredReattachLiveData = []
        deferredReattachLiveDataChars = 0
        deferredReattachLiveDataOwners = new Map()
      }
      if (!deferredReattachLiveDataOwners.has(ownerGeneration)) {
        deferredReattachLiveDataOwners.set(ownerGeneration, { failed: false })
      }
    }

    const finishReattachLiveDataDeferral = (
      deliver: boolean,
      acceptedGeneration = transportStreamGeneration
    ): void => {
      if (reattachLiveDataDeferralDepth <= 0) {
        return
      }
      if (!deliver) {
        const owner = deferredReattachLiveDataOwners.get(acceptedGeneration)
        if (owner) {
          owner.failed = true
        }
      }
      reattachLiveDataDeferralDepth -= 1
      if (reattachLiveDataDeferralDepth > 0) {
        return
      }
      const chunks = deferredReattachLiveData
      deferredReattachLiveData = null
      deferredReattachLiveDataChars = 0
      const currentPtyId = transport.getPtyId()
      const currentGeneration = transportStreamGeneration
      const currentOwner = deferredReattachLiveDataOwners.get(currentGeneration)
      deferredReattachLiveDataOwners = new Map()
      if (disposed || !chunks) {
        return
      }
      // Why: createOrAttach snapshots precede bytes emitted before its IPC
      // reply. Paint the authoritative replay first, then admit those live
      // chunks so the replay clear cannot erase newer output.
      let deliveredDeferredChunks = 0
      for (const chunk of chunks) {
        if (
          chunk.ptyId !== currentPtyId ||
          chunk.streamGeneration !== currentGeneration ||
          currentOwner?.failed === true
        ) {
          continue
        }
        dataCallback(chunk.data, chunk.meta, chunk.streamGeneration)
        deliveredDeferredChunks += 1
      }
      if (deliveredDeferredChunks > 0) {
        // Why: replay restores the viewport before these newer bytes parse;
        // settle the bounded deferred slice, then apply the latest user intent.
        flushTerminalOutput(pane.terminal, { maxChars: MAX_DEFERRED_REATTACH_LIVE_CHARS })
        void waitForTerminalReplayWritesParsed(pane.terminal).then(() => {
          if (
            disposed ||
            !deps.isVisibleRef.current ||
            transport.getPtyId() !== currentPtyId ||
            transportStreamGeneration !== currentGeneration
          ) {
            return
          }
          enforceTerminalCurrentScrollIntent(pane.terminal)
        })
      }
    }

    const handleReattachResult = async (
      result: PtyConnectResult | string | void,
      staleSessionId?: string | null,
      coldRestoreStartup?: ColdRestoreAgentResumeStartup | null,
      attemptGeneration = transportStreamGeneration
    ): Promise<boolean> => {
      if (disposed) {
        return false
      }
      if (attemptGeneration !== transportStreamGeneration) {
        return false
      }
      const connectResult =
        result && typeof result === 'object' && 'id' in result ? (result as PtyConnectResult) : null

      if (connectResult?.exitedBeforeAttach) {
        // Why: the transport already delivered the dead session's final frame
        // and exit. Treat it as terminal state, not a failed reattach that
        // should silently replace a cancelled pinned exit with a fresh shell.
        return true
      }

      const ptyId =
        connectResult?.id ?? (typeof result === 'string' ? result : transport.getPtyId())
      if (!ptyId) {
        warnTerminalLifecycleAnomaly('restored PTY reattach returned no PTY id', {
          tabId: deps.tabId,
          worktreeId: deps.worktreeId,
          leafId: deps.restoredLeafId ?? pane.leafId,
          paneId: pane.id,
          ptyId: staleSessionId ?? null
        })
        // Why: a stale restored daemon/SSH session can fail reattach after the
        // pane is mounted. Do not leave xterm alive without a backing PTY.
        if (staleSessionId) {
          deps.clearExitedPanePtyLayoutBinding(pane.id, staleSessionId)
        } else {
          deps.syncPanePtyLayoutBinding(pane.id, null)
        }
        if (staleSessionId) {
          deps.clearTabPtyId(deps.tabId, staleSessionId)
        }
        startFreshColdRestoreAgentResume(coldRestoreStartup, {
          forceBlankRestoredViewport: true
        })
        return false
      }
      registerEffectiveLaunchConfig(connectResult?.launchConfig, {
        ...(coldRestoreStartup ? { launchToken: coldRestoreStartup.launchToken } : {}),
        ...(connectResult?.launchAgent
          ? { launchAgent: connectResult.launchAgent }
          : coldRestoreStartup
            ? { launchAgent: coldRestoreStartup.agent }
            : {})
      })
      if (connectResult?.sessionExpired) {
        if (staleSessionId) {
          deps.clearExitedPanePtyLayoutBinding(pane.id, staleSessionId)
        } else {
          deps.syncPanePtyLayoutBinding(pane.id, null)
        }
        if (staleSessionId) {
          deps.clearTabPtyId(deps.tabId, staleSessionId)
        }
        // Why: SSH sleep/reconnect can invalidate the relay-held PTY while
        // leaving the tab mounted. Replace the dead lease in-place instead of
        // stranding the pane behind a stale expired-session overlay.
        startFreshColdRestoreAgentResume(coldRestoreStartup, {
          forceBlankRestoredViewport: true
        })
        return false
      }
      const isCurrentReattachPayload = (): boolean => {
        const currentPtyId = transport.getPtyId()
        return (
          !disposed && attemptGeneration === transportStreamGeneration && currentPtyId === ptyId
        )
      }
      if (!isCurrentReattachPayload()) {
        return false
      }
      setPanePtyFitBinding(ptyId)
      reportPanePtyVisibility(ptyId, deps.isVisibleRef.current)
      registerSideEffectFactConsumerForPty(ptyId)
      syncHiddenRendererPtyDelivery()
      deps.syncPanePtyLayoutBinding(pane.id, ptyId)
      deps.updateTabPtyId(deps.tabId, ptyId)
      agentCompletionCoordinator.startProcessTracking()
      sampleVisiblePaneForegroundAgent()

      // Why: mobile terminal streaming needs the exact screen state from
      // xterm.js. The shared helper installs both the SerializeAddon-backed
      // serializer and the onTitleChange-driven lastTitle source so the
      // main-process hydration path has full status parity.
      registerPaneSerializerFor(ptyId)

      // Strict precedence: snapshot > replay > coldRestore. Paint exactly
      // one source per reattach. Painting snapshot AND replay produced the
      // duplicated TUI output users saw on worktree switch (the relay replay
      // buffer's tail typically overlaps with the daemon snapshot's tail, so
      // both writing into xterm doubles the same lines). Snapshot wins
      // because the daemon's authoritative buffer is freshest when present;
      // replay wins over coldRestore because the relay's last 100 KB is
      // newer than disk-recorded scrollback. If we ever return all three,
      // the daemon and relay are by definition tracking the same session
      // and only the freshest source belongs on screen.
      const hasStructuralReplay = Boolean(
        connectResult?.snapshot || connectResult?.replay || connectResult?.coldRestore
      )
      let reattachPayloadApplied = !hasStructuralReplay
      const applyReattachPayload = async (): Promise<void> => {
        if (!isCurrentReattachPayload()) {
          return
        }
        if (connectResult?.snapshot) {
          rememberReattachPayloadAgentSignal(connectResult.snapshot, { fullScreenReplay: true })
          // Why: the daemon serializes its grid with soft-wrapped lines as
          // continuous text. Replaying that at a different column count rewraps
          // rows one cell early/late (bug #7279). Replay at the snapshot's own
          // dimensions first; safeFit below fits the pane back and resizes the
          // remote PTY. Suppress the xterm->PTY forward so this layout-only
          // resize does not SIGWINCH the live remote TUI. Mirrors
          // applyMainBufferSnapshot.
          const snapshotCols = connectResult.snapshotCols
          const snapshotRows = connectResult.snapshotRows
          const hasSnapshotDimensions =
            typeof snapshotCols === 'number' &&
            typeof snapshotRows === 'number' &&
            Number.isFinite(snapshotCols) &&
            Number.isFinite(snapshotRows) &&
            snapshotCols > 0 &&
            snapshotRows > 0
          if (
            hasSnapshotDimensions &&
            (pane.terminal.cols !== snapshotCols || pane.terminal.rows !== snapshotRows)
          ) {
            suppressStructuralReplayPtyResize = true
            try {
              pane.terminal.resize(snapshotCols, snapshotRows)
            } finally {
              suppressStructuralReplayPtyResize = false
            }
          }
          writeReplayData('\x1b[2J\x1b[3J\x1b[H')
          // Why: the daemon snapshot's rehydrate preamble carries the live
          // session's kitty keyboard flags; re-arm the mirror from it so Option
          // chords keep their kitty encoding after a window reload.
          kittyKeyboardModes.scanReplay(connectResult.snapshot)
          writeReplayData(connectResult.snapshot)
          // Snapshot reattach keeps a live session, so avoid the broader mode
          // reset. We only drop renderer-owned state that should not leak from
          // replay bytes into the restored renderer terminal.
          writeReplayData(reattachReplayResetSequence(connectResult.snapshot))
          if (connectResult.pendingEscapeTailAnsi) {
            // Why last: re-arm the daemon's dangling mid-escape sequence AFTER the
            // reset (whose ESC would abort it) so the racing live continuation
            // completes it instead of rendering literally (#7329).
            writeReplayData(connectResult.pendingEscapeTailAnsi)
          }
          sendFocusedReattachFocusInAfterReplay(ptyId, attemptGeneration)
          if (connectResult.coldRestore) {
            // Snapshot superseded the cold-restore payload — ack it so the
            // daemon does not redeliver it on the next reattach.
            if (!isRemoteRuntimePtyId(ptyId)) {
              window.api.pty.ackColdRestore(ptyId)
            }
          }
        } else if (connectResult?.replay) {
          rememberReattachPayloadAgentSignal(connectResult.replay, { fullScreenReplay: true })
          // Relay replay holds the last 100 KB of raw output. The xterm may
          // already hold pre-disconnect content; clear first to avoid
          // duplication. The reattach reset clears renderer-owned state without
          // tearing down the still-running TUI's live modes.
          writeReplayData('\x1b[2J\x1b[3J\x1b[H')
          // Why: raw relay replay contains the application's own kitty pushes
          // when they fall inside the retained window; re-arm the mirror with
          // replay (set) semantics so redelivery cannot grow the stack.
          kittyKeyboardModes.scanReplay(connectResult.replay)
          writeReplayData(connectResult.replay)
          writeReplayData(reattachReplayResetSequence(connectResult.replay))
          sendFocusedReattachFocusInAfterReplay(ptyId, attemptGeneration)
          if (connectResult.coldRestore) {
            if (!isRemoteRuntimePtyId(ptyId)) {
              window.api.pty.ackColdRestore(ptyId)
            }
          }
        } else if (connectResult?.coldRestore) {
          let destinationRows = pane.terminal.rows
          try {
            const proposedDestination = pane.fitAddon.proposeDimensions()
            if (
              proposedDestination &&
              Number.isFinite(proposedDestination.rows) &&
              proposedDestination.rows > 0
            ) {
              destinationRows = Math.max(destinationRows, proposedDestination.rows)
            }
          } catch {
            // The current xterm grid remains a safe lower bound for blanking.
          }
          // Why: shrinking first would promote clipped stale viewport rows into
          // scrollback, beyond the reach of a later viewport-only clear.
          writeReplayData('\x1b[2J\x1b[H')
          await waitForTerminalReplayWritesParsed(pane.terminal)
          if (!isCurrentReattachPayload()) {
            return
          }
          const coldRestoreCols = connectResult.coldRestore.cols
          const coldRestoreRows = connectResult.coldRestore.rows
          const hasColdRestoreDimensions =
            typeof coldRestoreCols === 'number' &&
            typeof coldRestoreRows === 'number' &&
            Number.isFinite(coldRestoreCols) &&
            Number.isFinite(coldRestoreRows) &&
            coldRestoreCols > 0 &&
            coldRestoreRows > 0
          if (
            hasColdRestoreDimensions &&
            (pane.terminal.cols !== coldRestoreCols || pane.terminal.rows !== coldRestoreRows)
          ) {
            // Why: recovered ANSI cursor positions belong to the checkpoint's
            // grid. Keep this layout-only resize from reaching the fresh PTY.
            suppressStructuralReplayPtyResize = true
            try {
              pane.terminal.resize(coldRestoreCols, coldRestoreRows)
            } finally {
              suppressStructuralReplayPtyResize = false
            }
          }
          // replayIntoTerminal: the recorded scrollback is raw PTY output that
          // may contain query sequences the previous agent CLI emitted;
          // writing them through xterm.write would trigger auto-replies that
          // land in the new shell's stdin. See replay-guard.ts.
          writeReplayData(connectResult.coldRestore.scrollback)
          const preparedStartup = coldRestoreStartup ?? buildColdRestoreAgentResumeStartup()
          const didPrepareResume = applyColdRestoreAgentResumeStartup(preparedStartup)
          if (didPrepareResume) {
            if (preparedStartup?.hasSleepingRecord) {
              showSessionRestoredBanner()
            }
            clearSleepingRecordAfterColdRestoreSpawn(preparedStartup)
          }
          // Cold-restore means the daemon lost the session and spawned a
          // fresh shell — no TUI is consuming the mode-setting bytes that a
          // crashed TUI (e.g. Claude's \e[?1004h) left in the scrollback, so
          // reset them to match the fresh shell's expectations.
          writeReplayData(POST_REPLAY_MODE_RESET)
          // Why: the dead run's scrollback was never scanned, and any kitty
          // flags it pushed died with it — the fresh shell starts at zero.
          kittyKeyboardModes.reset()
          consumeRestoredViewportBlankingMarker()
          // Why: a taller destination fit must not pull recovered rows back
          // into the fresh shell's viewport after source-grid replay.
          writeFreshShellViewportBlanking(Math.max(destinationRows, pane.terminal.rows))
          if (!isRemoteRuntimePtyId(ptyId)) {
            window.api.pty.ackColdRestore(ptyId)
          }
          if (didPrepareResume && !coldRestoreStartup) {
            schedulePendingStartupCommandDelivery()
          }
        }
        if (hasStructuralReplay) {
          await waitForTerminalReplayWritesParsed(pane.terminal)
          if (!isCurrentReattachPayload()) {
            return
          }
          reattachPayloadApplied = true
        }
      }

      const fitAfterReattachRestore = async (): Promise<void> => {
        if (!isCurrentReattachPayload()) {
          return
        }
        const reattachPtyId = transport.getPtyId()
        if (!reattachPtyId) {
          return
        }
        if (!getFitOverrideForPty(reattachPtyId)) {
          const fit = safeFitAndThen(
            pane,
            'reattach-pty-resize',
            () => {
              if (!isCurrentReattachPayload() || transport.getPtyId() !== reattachPtyId) {
                return
              }
              const reattachCols = pane.terminal.cols
              const reattachRows = pane.terminal.rows
              if (reattachCols > 0 && reattachRows > 0) {
                transport.resize(reattachCols, reattachRows)
              }
              // Why: POSIX only delivers SIGWINCH when terminal dimensions actually
              // change. Sending it explicitly guarantees restored TUIs repaint at
              // the correct cursor position after snapshot replay.
              if (!isRemoteRuntimePtyId(reattachPtyId)) {
                window.api.pty.signal(reattachPtyId, 'SIGWINCH')
              }
            },
            { shouldContinue: isCurrentReattachPayload, retryIfUnmeasurable: true }
          )
          pendingReattachFit = fit
          let fitCompleted = false
          try {
            fitCompleted = await fit.completion
          } finally {
            if (pendingReattachFit === fit) {
              pendingReattachFit = null
            }
          }
          if (fitCompleted && isCurrentReattachPayload() && deps.isVisibleRef.current) {
            // Why: reattach resize is fire-and-forget; verify the provider's
            // applied grid while this reveal still owns the visible pane.
            ptySizeReassertion.request({ fit: false })
          }
        } else if (isCurrentReattachPayload() && !isRemoteRuntimePtyId(reattachPtyId)) {
          window.api.pty.signal(reattachPtyId, 'SIGWINCH')
        }
      }
      if (hasStructuralReplay) {
        await structuralReplayCoordinator.run(applyReattachPayload, {
          shouldRestore: isCurrentReattachPayload,
          afterRestore: fitAfterReattachRestore
        })
      } else {
        await applyReattachPayload()
        await fitAfterReattachRestore()
      }
      if (!isCurrentReattachPayload() || !reattachPayloadApplied) {
        return false
      }
      scheduleReattachIdleAgentCursorReset()

      scheduleRuntimeGraphSync()
      return true
    }

    // Why: if this tab has a deferred SSH session ID, trigger the SSH
    // connection now that the user has focused the tab. We check per-tab
    // (not per-target) because multiple tabs for the same target each need
    // to reattach independently. This must run before session ID resolution
    // because the SSH provider isn't registered until after connect succeeds.
    if (connectionId) {
      const storeState = useAppStore.getState()
      // Why: the SSH target was removed entirely (a ghost workspace). Reattaching
      // can only fail with "SSH target not found", which surfaces a red "file an
      // issue" banner for what is an expected user action. Skip reattach — the
      // terminal overlay already shows a "host removed" state with a remove
      // action. Runtime-owned targets aren't user-managed, so they're exempt.
      // A target map that exists but omits this id means the target was removed.
      // (Guard the map's presence for minimal test stubs that omit it; an absent
      // map is "not hydrated", not "target gone".)
      if (
        !isRuntimeOwnedSshTargetId(connectionId) &&
        storeState.sshTargetLabels instanceof Map &&
        !storeState.sshTargetLabels.has(connectionId)
      ) {
        return
      }
      const restoredLeafSessionId =
        deps.restoredLeafId && deps.restoredPtyIdByLeafId
          ? (deps.restoredPtyIdByLeafId[deps.restoredLeafId] ?? null)
          : null
      const gate = resolveSshPaneConnectGate({
        connectionId,
        sshStatus: storeState.sshConnectionStates.get(connectionId)?.status,
        isDeferredTarget: storeState.deferredSshReconnectTargets.includes(connectionId),
        restoredLeafSessionId,
        deferredTabSessionId: storeState.deferredSshSessionIdsByTabId[deps.tabId],
        tabPtyId: storeState.tabsByWorktree[deps.worktreeId]?.find((t) => t.id === deps.tabId)
          ?.ptyId,
        hasLeafSessionMap: Boolean(
          deps.restoredPtyIdByLeafId && Object.keys(deps.restoredPtyIdByLeafId).length > 0
        )
      })
      const pendingSessionId = gate.pendingSessionId
      console.warn(
        `[pty-connection] SSH tab=${deps.tabId} connectionId=${connectionId} pendingSessionId=${pendingSessionId} sshConnected=${gate.sshConnected}`
      )
      if (gate.enterDeferredFlow) {
        void (async () => {
          // Why: if the target requires a passphrase/password and no credential
          // is cached yet, auto-firing ssh.connect would surprise the user —
          // a prompt pops unprompted just because they focused a tab / jumped
          // via Cmd+J. Wait for the user to initiate the connect (via
          // SshDisconnectedDialog → passphrase dialog) before proceeding with
          // the PTY reattach. No-passphrase targets (ssh-agent, unencrypted
          // key, cached creds) return false here and continue auto-connecting
          // as before.
          let needsPrompt = false
          try {
            needsPrompt = await window.api.ssh.needsPassphrasePrompt({
              targetId: connectionId
            })
          } catch (err) {
            console.warn('[pty-connection] needsPassphrasePrompt probe failed:', err)
            // Why: if the probe fails, fall through to the existing auto-connect
            // behavior rather than stranding the tab — a stuck tab is worse
            // than a surprising prompt.
          }
          if (disposed) {
            return
          }
          if (needsPrompt) {
            const alreadyConnected =
              useAppStore.getState().sshConnectionStates.get(connectionId)?.status === 'connected'
            if (!alreadyConnected) {
              // Wait for the user-driven connect (SshDisconnectedDialog →
              // passphrase dialog → ssh.connect) to complete, then continue.
              // Why: resolve on terminal-failure statuses too ('auth-failed',
              // 'error', 'reconnection-failed') so this promise can't hang
              // forever if the user cancels or the connect fails —
              // waitForSshConnection below has its own error path that will
              // surface the failure via reportError.
              const outcome = await new Promise<UserInitiatedSshConnectOutcome>((resolve) => {
                // Why: 'disconnected' counts as terminal only after we've
                // observed a non-disconnected status — i.e. the user actually
                // initiated a connect attempt that returned to 'disconnected'
                // (cancel/dismiss). Treating the entry-time 'disconnected'
                // as terminal would skip the gate entirely, defeating the
                // passphrase-prompt deferral.
                let sawNonDisconnected =
                  useAppStore.getState().sshConnectionStates.get(connectionId)?.status !==
                    'disconnected' &&
                  useAppStore.getState().sshConnectionStates.get(connectionId)?.status !== undefined
                let resolvedOutcome: UserInitiatedSshConnectOutcome = 'cancelled'
                let settled = false
                const finish = (nextOutcome: UserInitiatedSshConnectOutcome): void => {
                  if (settled) {
                    return
                  }
                  resolvedOutcome = nextOutcome
                  settled = true
                  unsub()
                  const idx = waitTeardowns.indexOf(teardown)
                  if (idx !== -1) {
                    waitTeardowns.splice(idx, 1)
                  }
                  resolve(resolvedOutcome)
                }
                const teardown = (): void => finish('cancelled')
                // Why: registering a teardown lets dispose() actively
                // unsubscribe + resolve if the pane is torn down while the
                // wait is in flight. Without this the zustand subscriber and
                // the surrounding async IIFE leak for the rest of the app
                // session because the callback only checks `disposed` when
                // it next fires — and it may never fire again.
                waitTeardowns.push(teardown)
                const unsub = useAppStore.subscribe((state) => {
                  if (disposed) {
                    finish('cancelled')
                    return
                  }
                  const status = state.sshConnectionStates.get(connectionId)?.status
                  if (status && status !== 'disconnected') {
                    sawNonDisconnected = true
                  }
                  const nextOutcome = sshPromptConnectOutcomeForStatus(status, sawNonDisconnected)
                  if (nextOutcome) {
                    finish(nextOutcome)
                  }
                })
                // Why: re-read state immediately after subscribing to close the
                // race where status transitioned between the alreadyConnected
                // check above and the subscribe registration — otherwise we'd
                // wait forever for a state change that already happened.
                if (disposed) {
                  finish('cancelled')
                  return
                }
                const currentStatus = useAppStore
                  .getState()
                  .sshConnectionStates.get(connectionId)?.status
                const currentOutcome = sshPromptConnectOutcomeForStatus(
                  currentStatus,
                  sawNonDisconnected
                )
                if (currentOutcome) {
                  finish(currentOutcome)
                }
              })
              if (disposed) {
                return
              }
              if (outcome === 'cancelled') {
                return
              }
              if (outcome === 'failed') {
                reportError('SSH connection failed')
                return
              }
            }
          }

          // Why: ensure the SSH connection is established before attempting
          // PTY reattach. Multiple panes/tabs may need the same connection,
          // so we wait for it rather than returning early when in-flight.
          const connectResult = await waitForSshConnection(connectionId)
          if (!connectResult.connected) {
            reportError(`SSH connection failed: ${connectResult.error}`)
            return
          }
          if (disposed) {
            return
          }
          useAppStore.getState().removeDeferredSshReconnectTarget(connectionId)
          if (disposed) {
            return
          }
          if (pendingSessionId) {
            console.warn(
              `[pty-connection] Attempting reattach for tab=${deps.tabId} sessionId=${pendingSessionId}`
            )
            // Why: the saved remote PTY ID is single-use restore metadata.
            // Clear it before attach/fallback so remounts don't keep retrying
            // an expired session after a fresh shell has been created.
            useAppStore.getState().removeDeferredSshSessionId(deps.tabId)
            // Why: pre-signal also for SSH-deferred reattach so the
            // cooperation gate uniformly applies to remote sessions. Issue
            // declare and connect back-to-back; Electron preserves order. See
            // docs/mobile-prefer-renderer-scrollback.md.
            const preSignalPromise =
              runtimeEnvironmentId || isRemoteRuntimePtyId(pendingSessionId)
                ? Promise.resolve(null)
                : window.api.pty.declarePendingPaneSerializer(cacheKey).catch(() => null)
            let expiredReattachError = false
            const coldRestoreStartup = buildColdRestoreAgentResumeStartup()
            clearPaneMode2031State()
            clearHiddenOutputRestoreState()
            const outputCallbacks = captureTransportOutputCallbacks((message) => {
              if (isSshSessionExpiredError(message)) {
                expiredReattachError = true
                return
              }
              reportError(message)
            })
            beginReattachLiveDataDeferral(outputCallbacks.generation)
            transportConnectInFlightSince = Date.now()
            const reattachPromise = transport.connect({
              url: '',
              cols,
              rows,
              sessionId: pendingSessionId,
              ...(coldRestoreStartup?.command ? { command: coldRestoreStartup.command } : {}),
              ...(coldRestoreStartup?.env
                ? { env: mergeStartupEnvWithPaneIdentity(coldRestoreStartup.env) }
                : {}),
              ...(coldRestoreStartup?.launchConfig
                ? { launchConfig: coldRestoreStartup.launchConfig }
                : {}),
              ...(coldRestoreStartup?.launchToken
                ? { launchToken: coldRestoreStartup.launchToken }
                : {}),
              ...(coldRestoreStartup?.agent ? { launchAgent: coldRestoreStartup.agent } : {}),
              ...(shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
              callbacks: outputCallbacks.callbacks
            })
            void Promise.resolve(reattachPromise)
              .catch(() => null)
              .finally(() => {
                transportConnectInFlightSince = null
              })
            void Promise.resolve(reattachPromise)
              .then(async (result) => {
                if (outputCallbacks.generation !== transportStreamGeneration) {
                  finishReattachLiveDataDeferral(false, outputCallbacks.generation)
                  const gen = await preSignalPromise
                  if (typeof gen === 'number') {
                    void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
                  }
                  return
                }
                console.warn(
                  `[pty-connection] Reattach result for tab=${deps.tabId}:`,
                  result
                    ? {
                        sessionExpired: (result as Record<string, unknown>).sessionExpired,
                        replay: !!(result as Record<string, unknown>).replay
                      }
                    : 'undefined'
                )
                if (!result && expiredReattachError) {
                  finishReattachLiveDataDeferral(false, outputCallbacks.generation)
                  const gen = await preSignalPromise
                  if (typeof gen === 'number') {
                    void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
                  }
                  if (disposed) {
                    return
                  }
                  deps.clearExitedPanePtyLayoutBinding(pane.id, pendingSessionId)
                  deps.clearTabPtyId(deps.tabId, pendingSessionId)
                  startFreshColdRestoreAgentResume(coldRestoreStartup, {
                    forceBlankRestoredViewport: true
                  })
                  return
                }
                const accepted = await handleReattachResult(
                  result,
                  pendingSessionId,
                  coldRestoreStartup,
                  outputCallbacks.generation
                )
                finishReattachLiveDataDeferral(accepted, outputCallbacks.generation)
                const gen = await preSignalPromise
                if (typeof gen === 'number') {
                  if (!isRemoteRuntimePtyId(pendingSessionId)) {
                    const settledPtyId =
                      result && typeof result === 'object' && 'id' in result
                        ? result.id
                        : (transport.getPtyId() ?? pendingSessionId)
                    const hasRestorePayload =
                      result &&
                      typeof result === 'object' &&
                      ('snapshot' in result || 'replay' in result || 'coldRestore' in result)
                    await (hasRestorePayload
                      ? settlePaneSerializerAfterReplay(settledPtyId, gen)
                      : window.api.pty.settlePaneSerializer(cacheKey, gen))
                  }
                }
              })
              .catch(async (err) => {
                finishReattachLiveDataDeferral(false, outputCallbacks.generation)
                const gen = await preSignalPromise
                if (typeof gen === 'number') {
                  void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
                }
                console.warn(`[pty-connection] Reattach FAILED for tab=${deps.tabId}:`, err)
                if (disposed || outputCallbacks.generation !== transportStreamGeneration) {
                  return
                }
                if (isSshSessionExpiredError(err)) {
                  deps.clearExitedPanePtyLayoutBinding(pane.id, pendingSessionId)
                  deps.clearTabPtyId(deps.tabId, pendingSessionId)
                  startFreshColdRestoreAgentResume(coldRestoreStartup, {
                    forceBlankRestoredViewport: true
                  })
                  return
                }
                startFreshColdRestoreAgentResume(coldRestoreStartup, {
                  forceBlankRestoredViewport: true
                })
              })
          } else {
            startFreshColdRestoreAgentResume()
          }
        })()
        return
      }
    }

    // Why: re-read session IDs inside the rAF instead of capturing before.
    // The session could be cleaned up during the one-frame gap, and
    // reading stale IDs would cause a reattach to a dead session.
    const restoredPtyId =
      deps.restoredLeafId && deps.restoredPtyIdByLeafId
        ? (deps.restoredPtyIdByLeafId[deps.restoredLeafId] ?? null)
        : null
    const storeSnapshot = useAppStore.getState()
    const existingPtyId = storeSnapshot.tabsByWorktree[deps.worktreeId]?.find(
      (t) => t.id === deps.tabId
    )?.ptyId
    const hasSleepingAgentSession = Boolean(getSleepingRecordForPane(storeSnapshot))

    // Why: a setup sibling can publish its PTY while the main pane waits for split geometry;
    // the tab-level fallback must not steal a PTY already owned by that sibling transport.
    const tabFallbackPtyId =
      existingPtyId &&
      !Array.from(deps.paneTransportsRef.current.entries()).some(
        ([candidatePaneId, candidateTransport]) =>
          candidatePaneId !== pane.id && candidateTransport.getPtyId() === existingPtyId
      )
        ? existingPtyId
        : null

    const restoredSessionId = restoredPtyId ?? null
    const sleptRemoteRuntimeSessionId =
      restoredSessionId && isRemoteRuntimePtyId(restoredSessionId) && hasSleepingAgentSession
        ? restoredSessionId
        : null
    const detachedLivePtyId =
      tabFallbackPtyId && !hadExistingPaneTransportAtConnect && !sleptRemoteRuntimeSessionId
        ? restoredSessionId
          ? restoredSessionId === tabFallbackPtyId
            ? restoredSessionId
            : null
          : tabFallbackPtyId
        : null
    const detachedRemoteLeafPtyId =
      restoredSessionId && isRemoteRuntimePtyId(restoredSessionId) && !hasSleepingAgentSession
        ? restoredSessionId
        : null
    const candidateReattachSessionId =
      restoredSessionId && restoredSessionId !== detachedLivePtyId
        ? restoredSessionId
        : detachedLivePtyId
    const sleptRemoteColdRestoreStartup = sleptRemoteRuntimeSessionId
      ? buildColdRestoreAgentResumeStartup()
      : null
    if (sleptRemoteRuntimeSessionId) {
      deps.syncPanePtyLayoutBinding(pane.id, null)
      deps.clearTabPtyId(deps.tabId, sleptRemoteRuntimeSessionId)
    }
    const currentTabLivePtyIds = storeSnapshot.ptyIdsByTabId[deps.tabId] ?? []
    const candidateHasEagerBuffer = Boolean(
      candidateReattachSessionId &&
      !isRemoteRuntimePtyId(candidateReattachSessionId) &&
      getEagerPtyBufferHandle(candidateReattachSessionId)
    )
    // Why: a still-live locally-spawned PTY (e.g. a background automation agent
    // launched before its tab mounts) keeps an eager buffer until a pane adopts
    // it. Such a PTY must be adopted via attach()+replay, not re-connected as a
    // daemon session — connect({ sessionId }) on a non-session ptyId spawns a
    // fresh shell and orphans the live agent. Presence of an eager buffer plus
    // current-tab live ownership is the discriminator; route these to attach.
    const eagerLivePtyId =
      candidateReattachSessionId &&
      candidateHasEagerBuffer &&
      currentTabLivePtyIds.includes(candidateReattachSessionId)
        ? candidateReattachSessionId
        : null
    // Why: daemon session IDs encode `${worktreeId}@@${uuid}`. After a daemon
    // crash + cold restore, corrupted or stale session-to-tab mappings can
    // cause a tab in workspace A to hold a ptyId from workspace B. Restoring
    // that session would paint the wrong terminal content in this pane. Drop
    // the reattach and spawn a fresh session instead.
    const deferredReattachSessionId =
      candidateReattachSessionId &&
      !isRemoteRuntimePtyId(candidateReattachSessionId) &&
      !candidateHasEagerBuffer &&
      isSessionOwnedByWorktree(candidateReattachSessionId, deps.worktreeId)
        ? candidateReattachSessionId
        : null
    recordPtyConnectDiagnostic(
      `pane=${pane.id} tab=${deps.tabId} restored=${restoredPtyId} existing=${existingPtyId} detached=${detachedRemoteLeafPtyId ?? detachedLivePtyId} reattach=${deferredReattachSessionId} hasTransport=${hadExistingPaneTransportAtConnect} pendingKey=${pendingSpawnKey}`
    )

    if (deferredReattachSessionId) {
      allowInitialIdleCacheSeed = true
      recordPtyConnectDiagnostic(`pane=${pane.id} -> REATTACH ${deferredReattachSessionId}`)

      // Why: reattach also pre-signals so the cooperation gate suppresses
      // the daemon seed for this paneKey. Reattach paths register their
      // serializer in handleReattachResult (via registerPaneSerializerFor),
      // mirroring the fresh-spawn path. We issue declare and the reattach
      // connect back-to-back without awaiting; Electron's ipcRenderer→ipcMain
      // channel preserves order. See
      // docs/mobile-prefer-renderer-scrollback.md (Renderer-side prerequisite
      // requirement #4).
      const preSignalPromise =
        runtimeEnvironmentId || isRemoteRuntimePtyId(deferredReattachSessionId)
          ? Promise.resolve(null)
          : window.api.pty.declarePendingPaneSerializer(cacheKey).catch(() => null)

      let expiredReattachError = false
      const coldRestoreStartup = buildColdRestoreAgentResumeStartup()
      const outputCallbacks = captureTransportOutputCallbacks((message) => {
        if (isSshSessionExpiredError(message)) {
          expiredReattachError = true
          return
        }
        reportError(message)
      })
      beginReattachLiveDataDeferral(outputCallbacks.generation)
      transportConnectInFlightSince = Date.now()
      const reattachPromise = transport.connect({
        url: '',
        cols,
        rows,
        sessionId: deferredReattachSessionId,
        ...(coldRestoreStartup?.command ? { command: coldRestoreStartup.command } : {}),
        ...(coldRestoreStartup?.env
          ? { env: mergeStartupEnvWithPaneIdentity(coldRestoreStartup.env) }
          : {}),
        ...(coldRestoreStartup?.launchConfig
          ? { launchConfig: coldRestoreStartup.launchConfig }
          : {}),
        ...(coldRestoreStartup?.launchToken ? { launchToken: coldRestoreStartup.launchToken } : {}),
        ...(coldRestoreStartup?.agent ? { launchAgent: coldRestoreStartup.agent } : {}),
        ...(shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
        callbacks: outputCallbacks.callbacks
      })

      void Promise.resolve(reattachPromise)
        .catch(() => null)
        .finally(() => {
          transportConnectInFlightSince = null
        })
      void Promise.resolve(reattachPromise)
        .then(async (result) => {
          if (outputCallbacks.generation !== transportStreamGeneration) {
            finishReattachLiveDataDeferral(false, outputCallbacks.generation)
            const gen = await preSignalPromise
            if (typeof gen === 'number') {
              void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
            }
            return
          }
          if (!result && expiredReattachError) {
            finishReattachLiveDataDeferral(false, outputCallbacks.generation)
            const gen = await preSignalPromise
            if (typeof gen === 'number') {
              void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
            }
            if (disposed) {
              return
            }
            deps.clearExitedPanePtyLayoutBinding(pane.id, deferredReattachSessionId)
            deps.clearTabPtyId(deps.tabId, deferredReattachSessionId)
            startFreshColdRestoreAgentResume(coldRestoreStartup, {
              forceBlankRestoredViewport: true
            })
            return
          }
          const accepted = await handleReattachResult(
            result,
            deferredReattachSessionId,
            coldRestoreStartup,
            outputCallbacks.generation
          )
          finishReattachLiveDataDeferral(accepted, outputCallbacks.generation)
          const gen = await preSignalPromise
          if (typeof gen === 'number') {
            if (!isRemoteRuntimePtyId(deferredReattachSessionId)) {
              const settledPtyId =
                result && typeof result === 'object' && 'id' in result
                  ? result.id
                  : (transport.getPtyId() ?? deferredReattachSessionId)
              const hasRestorePayload =
                result &&
                typeof result === 'object' &&
                ('snapshot' in result || 'replay' in result || 'coldRestore' in result)
              await (hasRestorePayload
                ? settlePaneSerializerAfterReplay(settledPtyId, gen)
                : window.api.pty.settlePaneSerializer(cacheKey, gen))
            }
          }
        })
        .catch(async (err) => {
          finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          const gen = await preSignalPromise
          if (typeof gen === 'number') {
            void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
          }
          const message = err instanceof Error ? err.message : String(err)
          if (outputCallbacks.generation !== transportStreamGeneration) {
            return
          }
          warnTerminalLifecycleAnomaly('restored PTY reattach threw', {
            tabId: deps.tabId,
            worktreeId: deps.worktreeId,
            leafId: deps.restoredLeafId ?? pane.leafId,
            paneId: pane.id,
            ptyId: deferredReattachSessionId,
            reason: message
          })
          deps.clearExitedPanePtyLayoutBinding(pane.id, deferredReattachSessionId)
          deps.clearTabPtyId(deps.tabId, deferredReattachSessionId)
          if (connectionId && isSshSessionExpiredError(err)) {
            startFreshColdRestoreAgentResume(coldRestoreStartup, {
              forceBlankRestoredViewport: true
            })
            return
          }
          reportError(message)
          startFreshColdRestoreAgentResume(coldRestoreStartup, {
            forceBlankRestoredViewport: true
          })
        })
    } else if (detachedRemoteLeafPtyId || detachedLivePtyId || eagerLivePtyId) {
      // Why: mirrored web terminal layouts mount one pane per host leaf.
      // Later leaves already have a pane transport, but must still attach to
      // their exact remote PTY instead of spawning replacement host tabs.
      // eagerLivePtyId covers a still-live background PTY (e.g. an automation
      // agent) whose restored id may not equal the tab ptyId yet still has a
      // live eager buffer to adopt.
      const attachPtyId = detachedRemoteLeafPtyId ?? detachedLivePtyId ?? eagerLivePtyId!
      recordPtyConnectDiagnostic(`pane=${pane.id} -> ATTACH detached=${attachPtyId}`)
      allowInitialIdleCacheSeed = false
      // Why: surface synchronous attach failures (e.g., the PTY died between
      // mount and remount, so window.api.pty.resize rejects) through
      // reportError so the pane shows a diagnostic instead of silently
      // leaving a blank surface. The deferred-reattach branch above uses
      // `.catch(reportError)` for the same reason. Commit the pane/tab
      // bindings only after attach returns: if attach throws, the stale
      // ptyId must also be cleared from the tab and a fresh spawn kicked
      // off — otherwise the next remount reads the same dead ptyId from
      // the store and lands in this branch again in a loop.
      try {
        clearPaneMode2031State()
        clearHiddenOutputRestoreState()
        const outputCallbacks = captureTransportOutputCallbacks(reportError)
        transport.attach({
          existingPtyId: attachPtyId,
          cols,
          rows,
          callbacks: outputCallbacks.callbacks
        })
        const attachedPtyId = transport.getPtyId() ?? attachPtyId
        bindActivePanePty(attachedPtyId, {
          updateTabPtyId: 'if-missing',
          sampleVisibleForegroundAgent: true
        })
        if (attachPtyId === eagerLivePtyId || isRemoteRuntimePtyId(attachedPtyId)) {
          registerPaneSerializerFor(attachedPtyId)
        }
      } catch (err) {
        reportError(err instanceof Error ? err.message : String(err))
        deps.clearTabPtyId(deps.tabId, attachPtyId)
        startFreshSpawn()
      }
    } else {
      allowInitialIdleCacheSeed = false
      const pendingSpawn = pendingSpawnByPaneKey.get(pendingSpawnKey)
      if (pendingSpawn) {
        recordPtyConnectDiagnostic(`pane=${pane.id} -> PENDING SPAWN`)
        void pendingSpawn
          .then((spawnedPtyId) => {
            if (disposed) {
              return
            }
            if (transport.getPtyId()) {
              return
            }
            if (!spawnedPtyId) {
              // Why: React StrictMode in dev can mount, start a spawn, then
              // immediately unmount/remount the pane. If the first mount never
              // produced a usable PTY ID, the remounted pane must issue its own
              // spawn instead of staying attached to a completed-but-empty
              // promise and rendering a dead terminal surface.
              if (!isWebTerminalSurfaceTabId(deps.tabId)) {
                console.warn(
                  `Pending PTY spawn for tab ${deps.tabId} resolved without a PTY id, retrying fresh spawn`
                )
              }
              if (sleptRemoteColdRestoreStartup || hasSleepingAgentSession) {
                startFreshColdRestoreAgentResume(sleptRemoteColdRestoreStartup ?? undefined)
              } else {
                startFreshSpawn()
              }
              return
            }
            clearPaneMode2031State()
            clearHiddenOutputRestoreState()
            const outputCallbacks = captureTransportOutputCallbacks(reportError)
            transport.attach({
              existingPtyId: spawnedPtyId,
              cols,
              rows,
              callbacks: outputCallbacks.callbacks
            })
            const attachedPtyId = transport.getPtyId() ?? spawnedPtyId
            // Why: this path reuses a PTY spawned by an earlier mount, so no
            // later spawn event will bind this remounted pane's DOM/container.
            bindActivePanePty(attachedPtyId, {
              updateTabPtyId: 'if-missing',
              sampleVisibleForegroundAgent: true
            })
          })
          .catch((err) => {
            reportError(err instanceof Error ? err.message : String(err))
          })
      } else {
        recordPtyConnectDiagnostic(`pane=${pane.id} -> FRESH SPAWN`)
        if (sleptRemoteColdRestoreStartup || hasSleepingAgentSession) {
          startFreshColdRestoreAgentResume(sleptRemoteColdRestoreStartup ?? undefined)
        } else {
          startFreshSpawn()
        }
      }
    }
    scheduleRuntimeGraphSync()
  }

  // Why: Wayland/CI compositors can keep timers and CDP responsive while the
  // next rAF never arrives; the terminal must still start its PTY once.
  connectFallbackTimer = setTimeout(runDeferredConnect, 250)
  connectFrame = requestAnimationFrame(runDeferredConnect)

  // Why: on visibility resume a pane may still be bound to a daemon session
  // reaped while hidden (the missed-exit defect). Route it through the SAME
  // teardown a real onExit runs. Re-validate identity at apply time so a
  // reattach racing the listSessions snapshot is never clobbered, and respect
  // the remote/SSH guards. Suppression semantics come for free via onExit
  // (which consults consumeSuppressedPtyExit) plus the per-ptyId guard above.
  const reconcileIfSessionDead = (
    liveSessionIds: Set<string>,
    snapshotRequestedAt?: number
  ): void => {
    if (disposed) {
      return
    }
    const currentPtyId = transport.getPtyId()
    if (
      !currentPtyId ||
      // Why: the current ptyId's exit was already handled — onExit guards this
      // too, but skipping here avoids a redundant shouldReconcile evaluation.
      handledExitPtyId === currentPtyId ||
      !shouldReconcileDeadSession({
        ptyId: currentPtyId,
        connectionId: transport.getConnectionId?.(),
        liveSessionIds,
        ptyBoundAt: activePanePtyBindingBoundAt,
        snapshotRequestedAt
      })
    ) {
      return
    }
    onExit(currentPtyId)
  }

  const reconcileIfSessionMissing = (
    hasPty: HasPty,
    livenessRequestedAt = performance.now()
  ): void => {
    const requestedPtyId = transport.getPtyId()
    if (
      !requestedPtyId ||
      requestedPtyId === handledExitPtyId ||
      requestedPtyId.startsWith(REMOTE_PTY_ID_PREFIX) ||
      transport.getConnectionId?.() != null
    ) {
      return
    }

    let livenessPromise: Promise<boolean | null>
    try {
      livenessPromise = Promise.resolve(hasPty(requestedPtyId))
    } catch {
      return
    }

    void livenessPromise
      .then((isLive) => {
        if (disposed) {
          return
        }
        const currentPtyId = transport.getPtyId()
        if (
          !currentPtyId ||
          currentPtyId !== requestedPtyId ||
          handledExitPtyId === currentPtyId ||
          !shouldReconcileMissingSession({
            ptyId: currentPtyId,
            connectionId: transport.getConnectionId?.(),
            isLive,
            ptyBoundAt: activePanePtyBindingBoundAt,
            livenessRequestedAt
          })
        ) {
          return
        }
        onExit(currentPtyId)
      })
      .catch(() => {})
  }

  return {
    syncProcessTracking() {
      agentCompletionCoordinator.startProcessTracking()
      // Why: the lifecycle hook calls this on every pane visibility flip —
      // the hidden-delivery gate must follow the same transitions.
      syncHiddenRendererPtyDelivery()
    },
    isHiddenDeliveryGateManagedPty() {
      return isHiddenDeliveryGateManagedPty(transport.getPtyId())
    },
    // Why: called from the lifecycle visibility effect so the visible-resume
    // size readback can repair dropped hidden resizes without refitting against
    // xterm's transient hidden DOM fallback.
    noteVisibilityResume() {
      ptySizeReassertion.request({ fit: false })
      consumeHibernatedAgentWake()
      requestKnownDroidReconfirmation()
      sampleVisiblePaneForegroundAgent()
    },
    // Why: mobile wake reaches this pane while it stays hidden on the desktop, so
    // it must consume only the armed hibernation wake — no size/foreground reads.
    wakeHibernatedAgentIfArmed(claimedProviderSessions) {
      if (hibernatedWakeInFlightClaimKey) {
        if (claimedProviderSessions?.has(hibernatedWakeInFlightClaimKey)) {
          return null
        }
        claimedProviderSessions?.add(hibernatedWakeInFlightClaimKey)
        return hibernatedWakeInFlightClaimKey
      }
      const consumedClaimKey = consumeHibernatedAgentWake(claimedProviderSessions)
      if (consumedClaimKey) {
        return consumedClaimKey
      }
      // Why: wake arrived mid-hibernation-kill — the record exists but onExit
      // has not armed the wake target yet (the transport is still bound to the
      // dying PTY). Only the exact PTY already marked for suppressed shutdown
      // may latch; a stale/manual record beside an ordinary live PTY must not.
      const state = useAppStore.getState()
      const recordEntry = getSleepingRecordForPane(state)
      const currentPtyId = transport.getPtyId()
      if (
        recordEntry &&
        isPassiveCompletedHibernationEvidence(recordEntry.record) &&
        currentPtyId !== null &&
        state.suppressedPtyExitIds[currentPtyId] === true &&
        !disposed &&
        hibernatedWakeTarget === null &&
        deps.paneTransportsRef.current.get(pane.id) === transport &&
        transport.getPtyId() === currentPtyId
      ) {
        const claimKey = getProviderSessionClaimKey(recordEntry.record)
        if (claimedProviderSessions?.has(claimKey)) {
          return null
        }
        claimedProviderSessions?.add(claimKey)
        pendingHibernatedWakeTarget = { ptyId: currentPtyId, record: recordEntry.record }
        return claimKey
      }
      return null
    },
    sampleForegroundAgentOnFocus() {
      requestKnownDroidReconfirmation()
      sampleVisiblePaneForegroundAgent()
    },
    requestDroidReconfirmation() {
      if (shiftEnterReconfirmTimer !== null) {
        clearTimeout(shiftEnterReconfirmTimer)
      }
      // Why: preserve rapid multiline input inside a confirmed Droid composer;
      // confirm only after the Shift+Enter burst goes idle.
      shiftEnterReconfirmTimer = setTimeout(() => {
        shiftEnterReconfirmTimer = null
        requestKnownDroidReconfirmation()
        sampleVisiblePaneForegroundAgent()
      }, SHIFT_ENTER_RECONFIRM_IDLE_MS)
    },
    reconcileIfSessionDead,
    reconcileIfSessionMissing,
    dispose() {
      disposed = true
      cancelPendingSafeFitContinuations(pane)
      pendingHiddenSnapshotFit = null
      pendingReattachFit = null
      // A normal park/reconnect/remount does not advance the recovery epoch;
      // invalidate this concrete xterm so its delayed retry cannot hit the next.
      terminalRecoveryInstance.unregister()
      unregisterUndeliverableWriteHandler()
      cancelHiddenOutputSnapshotScrollRestore()
      structuralReplayCoordinator.dispose()
      cancelFreshSpawnFollowReset()
      // Why: the post-spawn reconcile polls across frames; cancel its pending
      // rAF so a torn-down pane cannot keep fitting/resizing after disposal.
      ptySizeReconcileHandle?.cancel()
      ptySizeReconcileHandle = null
      startupGridSettleHandle?.cancel()
      startupGridSettleHandle = null
      ptySizeReassertion.dispose()
      if (pendingForegroundGridDriftCheckRaf !== null) {
        cancelAnimationFrame(pendingForegroundGridDriftCheckRaf)
        pendingForegroundGridDriftCheckRaf = null
      }
      // Why: a pane unmount (tab move, parking teardown) must never leave its
      // PTY gated — the parked watcher or the remounted pane re-decides.
      releaseHiddenRendererPtyDelivery()
      if (terminalKeyTargetSupportsEvents) {
        terminalKeyTarget.removeEventListener('keydown', onTerminalKeyDown, { capture: true })
      }
      clearPendingTerminalInputIntent()
      pendingTerminalInputWrite = null
      interruptInference.dispose()
      clearTitleOnlyInterruptTimer()
      clearCommandCodeOutputDoneTimer()
      if (shiftEnterReconfirmTimer !== null) {
        clearTimeout(shiftEnterReconfirmTimer)
        shiftEnterReconfirmTimer = null
      }
      // Why: actively resolve any in-flight passphrase-gate waits so their
      // zustand subscribers + async IIFEs don't hang for the rest of the
      // session when the pane is torn down before SSH state changes.
      while (waitTeardowns.length > 0) {
        const teardown = waitTeardowns.pop()
        teardown?.()
      }
      if (startupInjectTimer !== null) {
        clearTimeout(startupInjectTimer)
        startupInjectTimer = null
      }
      if (sshShellReadyFallbackTimer !== null) {
        clearTimeout(sshShellReadyFallbackTimer)
        sshShellReadyFallbackTimer = null
      }
      cleanupStartupDraftPasteTimers()
      releaseUnattemptedStartupDraftPasteDelivery()
      unregisterAgentHookTerminalLifecycle()
      clearSuppressedTitleSideEffects()
      clearPendingAgentTaskCompleteNotification()
      pendingTerminalBellNotification = false
      clearTerminalBellNotificationTimer()
      clearReattachIdleAgentCursorResetTimer()
      if (alternateScreenBackgroundRepaintTimer !== null) {
        clearTimeout(alternateScreenBackgroundRepaintTimer)
        alternateScreenBackgroundRepaintTimer = null
      }
      cleanupHiddenOutputRestoreDeferredRetry()
      cleanupHiddenOutputRestoreForegroundDeadline()
      cleanupHiddenOutputRestoreFloodRepaint()
      unregisterBacklogRecovery?.()
      unregisterBacklogRecovery = null
      unregisterDocumentVisibilityRecovery?.()
      unregisterDocumentVisibilityRecovery = null
      releaseRendererPtyVisibilityClaim(transport)
      // Why: a parked-tab watcher may take over this PTY's facts in the same
      // effect flush; the pane's consumer must be gone before that handoff.
      dropSideEffectFactConsumer()
      clearPanePtyFitBinding()
      discardTerminalOutput(pane.terminal)
      unregisterE2ePtyDataInjection()
      if (agentTaskCompleteSettingsUnsubscribe !== null) {
        agentTaskCompleteSettingsUnsubscribe()
        agentTaskCompleteSettingsUnsubscribe = null
      }
      if (unsubscribeWindowsDoneTerminalModeReset !== null) {
        unsubscribeWindowsDoneTerminalModeReset()
        unsubscribeWindowsDoneTerminalModeReset = null
      }
      if (connectFrame !== null) {
        // Why: StrictMode and split-group remounts can dispose a pane binding
        // before its deferred PTY attach/spawn work runs. Cancel that queued
        // frame so stale bindings cannot reattach the PTY and steal the live
        // handler wiring from the current pane.
        cancelScheduledConnectFrame()
      }
      if (connectFallbackTimer !== null) {
        clearTimeout(connectFallbackTimer)
        connectFallbackTimer = null
      }
      onDataDisposable.dispose()
      userInputActivityDisposable?.dispose()
      terminalCapabilityRepliesDisposable.dispose()
      onResizeDisposable.dispose()
      onBufferChangeDisposable?.dispose()
      pane.container.removeEventListener(PANE_PTY_RESIZE_HOLD_FLUSH_EVENT, onHeldPtyResizeFlush)
      geometryReportObserver?.disconnect()
      if (pendingGeometryReportRaf !== null) {
        cancelAnimationFrame(pendingGeometryReportRaf)
        pendingGeometryReportRaf = null
      }
      commandLifecycle.dispose()
      deferredCommandFinishedStatusDrop = null
      visibleForegroundSamplePending = false
      visibleForegroundSampleSettled = false
      paneForegroundAgentTracker.dispose()
      agentCompletionCoordinator.dispose()
    }
  }
}
