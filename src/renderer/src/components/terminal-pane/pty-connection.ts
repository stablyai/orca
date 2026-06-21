/* oxlint-disable max-lines */
import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { IDisposable } from '@xterm/xterm'
import {
  detectAgentStatusFromTitle,
  isGeminiTerminalTitle,
  isClaudeAgent
} from '@/lib/agent-status'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
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
import type { PtyConnectionDeps } from './pty-connection-types'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty, bindPanePtyId } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { isPaneReplaying, replayIntoTerminal, replayIntoTerminalAsync } from './replay-guard'
import { terminalOutputPrefersRenderRefresh } from '@/lib/pane-manager/terminal-complex-script'
import {
  PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
  queuePanePtyResizeIfHeld,
  type PanePtyResizeHoldFlushDetail
} from '@/lib/pane-manager/pane-pty-resize-hold'
import {
  POST_REPLAY_LIVE_SNAPSHOT_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_TERMINAL_CURSOR_STYLE
} from './layout-serialization'
import { createShellReadyMarkerScanState, scanForShellReadyMarker } from './shell-ready-marker-scan'
import { shouldUseShellReadyStartupDelivery } from '../../../../shared/codex-startup-delivery'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import {
  mode2031SequenceFor,
  resolveTerminalColorSchemeMode,
  scanMode2031Sequences
} from '../../../../shared/terminal-color-scheme-protocol'
import { warnTerminalLifecycleAnomaly } from './terminal-lifecycle-diagnostics'
import { registerPtySerializer, registerPtyTitleSource } from './pty-buffer-serializer'
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
import { isLocalNativeWindowsPty } from '@/lib/pane-manager/windows-pty-compatibility'
import { recordTerminalOutput, restoreScrollStateAfterLayout } from '@/lib/pane-manager/pane-scroll'
import type { ScrollState } from '@/lib/pane-manager/pane-manager-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { makePaneKey, parseLegacyNumericPaneKey } from '../../../../shared/stable-pane-id'
import { createTerminalCommandLifecycle } from './terminal-command-lifecycle'
import { e2eConfig } from '@/lib/e2e-config'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isWebTerminalSurfaceTabId } from '@/runtime/web-terminal-surface-id'
import {
  createAgentInterruptInference,
  isCtrlCKeyEvent,
  isPlainEscapeKeyEvent
} from './agent-interrupt-inference'
import {
  AGENT_INTERRUPT_SETTLE_MS,
  type AgentInterruptInputIntent
} from '../../../../shared/agent-interrupt-intent'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import {
  markTerminalBracketedPasteInterrupted,
  observeTerminalBracketedPasteModeOutput
} from './terminal-bracketed-paste'
import { executeTerminalStartupCommandPaste } from './terminal-startup-command-paste'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { isCodexTerminalStartupCommand } from './terminal-startup-command-classifier'
import { createCommandCodeOutputStatusDetector } from './command-code-output-status'
import type { PtyDataMeta } from './pty-dispatcher'
import { getEagerPtyBufferHandle } from './pty-dispatcher'
import { createTerminalGitHubPRLinkDetector } from '@/lib/terminal-github-pr-link-detector'
import {
  CONPTY_DA1_RESPONSE,
  createTerminalPixelSizeQueryResponder,
  installTerminalCapabilityReplyHandlers
} from './terminal-capability-replies'
import {
  cancelScheduledHiddenOutputRestore,
  scheduleHiddenOutputRestore
} from './hidden-output-restore-scheduler'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status-terminal-title'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type ResumableTuiAgent,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../../shared/types'
import { isWslUncPath } from '../../../../shared/wsl-paths'

const pendingSpawnByPaneKey = new Map<string, Promise<string | null>>()
const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
const REMOTE_PTY_ID_PREFIX = 'remote:'
const PTY_CONNECT_DIAG_LIMIT = 200
const AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS = 250
const AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS = 1500
const AGENT_TASK_COMPLETE_NOTIFICATION_DETAIL_MAX_AGE_MS = 10_000
const COMMAND_CODE_OUTPUT_DONE_SETTLE_MS = 1500
const SSH_SHELL_READY_STARTUP_FALLBACK_MS = 1500
const HIDDEN_OUTPUT_RESTORE_SCROLLBACK_ROWS = 5000
const HIDDEN_OUTPUT_RESTORE_PENDING_CHARS = 512 * 1024
const HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MS = 50
const HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MAX = 3
const TERMINAL_RENDERER_RISK_SCAN_TAIL_CHARS = 256
const CURSOR_SHOW_SEQUENCE = '\x1b[?25h'
const CURSOR_HIDE_SEQUENCE = '\x1b[?25l'
const REATTACH_IDLE_AGENT_CURSOR_RESET_DELAY_MS = 250
const FOREGROUND_THROUGHPUT_IMMEDIATE_CHARS = 2048
const FOREGROUND_INTERACTIVE_REDRAW_CHARS = 128 * 1024
const FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS = 150
// Why: OpenTUI can emit many tiny redraws that each look interactive but
// collectively starve timers unless foreground writes have a rolling budget.
const FOREGROUND_IMMEDIATE_BUDGET_CHARS = 128 * 1024
const FOREGROUND_BUDGET_WINDOW_MS = 500
const INACTIVE_FOREGROUND_IMMEDIATE_BUDGET_CHARS = 32 * 1024
// Why: this is only shown if hidden renderer output was skipped and main-owned
// terminal state is unavailable, so the user has an explicit loss signal.
const HIDDEN_OUTPUT_RESTORE_UNAVAILABLE_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped hidden terminal output because main recovery was unavailable.]\r\n'
type E2eTerminalPtyDataInjectionApi = {
  inject: (paneKey: string, data: string, meta?: PtyDataMeta) => boolean
  keys: () => string[]
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
    startup?.telemetry?.agent_kind === 'codex' ||
    isCodexTerminalStartupCommand(startup?.command ?? '')
  )
}

function containsHiddenStartupRendererQuery(data: string): boolean {
  // Why: hidden Codex startup must not live-render ordinary redraw floods, but
  // query chunks still need xterm's built-in terminal replies to unblock TUIs.
  return containsCsiRendererQuery(data) || data.includes('\x1b]10;?') || data.includes('\x1b]11;?')
}

const HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS = 64
const HIDDEN_STARTUP_OSC_COLOR_QUERY_PREFIXES = ['\x1b]10;?', '\x1b]11;?'] as const

function findOscTerminatorIndex(data: string, offset: number): number {
  for (let index = offset; index < data.length; index++) {
    const code = data.charCodeAt(index)
    if (code === 0x07) {
      return index + 1
    }
    if (code === 0x1b && data[index + 1] === '\\') {
      return index + 2
    }
  }
  return -1
}

function extractHiddenStartupRendererQueryData(
  data: string,
  pending: string
): { statelessQueryData: string; statefulQueryData: string; pending: string } {
  const input = pending + data
  let statelessQueryData = ''
  let statefulQueryData = ''
  let offset = 0

  while (offset < input.length) {
    const candidateIndex = input.indexOf('\x1b', offset)
    if (candidateIndex === -1) {
      break
    }
    if (candidateIndex + 1 >= input.length) {
      return { statelessQueryData, statefulQueryData, pending: input.slice(candidateIndex) }
    }
    if (input.startsWith('\x1b[', candidateIndex)) {
      const finalByteIndex = findCsiFinalByteIndex(input, candidateIndex + 2)
      if (finalByteIndex === -1) {
        return {
          statelessQueryData,
          statefulQueryData,
          pending: input.slice(
            candidateIndex,
            candidateIndex + HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS
          )
        }
      }
      const sequence = input.slice(candidateIndex, finalByteIndex + 1)
      if (isStatelessRendererReplyCsiQuery(sequence)) {
        statelessQueryData += sequence
      } else if (isStatefulRendererReplyCsiQuery(sequence)) {
        statefulQueryData += sequence
      }
      offset = finalByteIndex + 1
      continue
    }

    if (input.startsWith('\x1b]', candidateIndex)) {
      const remaining = input.slice(candidateIndex)
      const matchingPrefix = HIDDEN_STARTUP_OSC_COLOR_QUERY_PREFIXES.find((prefix) =>
        remaining.startsWith(prefix)
      )
      if (!matchingPrefix) {
        if (
          HIDDEN_STARTUP_OSC_COLOR_QUERY_PREFIXES.some((prefix) => prefix.startsWith(remaining))
        ) {
          return { statelessQueryData, statefulQueryData, pending: remaining }
        }
        offset = candidateIndex + 2
        continue
      }

      const terminatorIndex = findOscTerminatorIndex(input, candidateIndex + matchingPrefix.length)
      if (terminatorIndex === -1) {
        return {
          statelessQueryData,
          statefulQueryData,
          pending: input.slice(
            candidateIndex,
            candidateIndex + HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS
          )
        }
      }
      statelessQueryData += input.slice(candidateIndex, terminatorIndex)
      offset = terminatorIndex
      continue
    }

    if (
      HIDDEN_STARTUP_OSC_COLOR_QUERY_PREFIXES.some((prefix) =>
        prefix.startsWith(input.slice(candidateIndex))
      )
    ) {
      return { statelessQueryData, statefulQueryData, pending: input.slice(candidateIndex) }
    }

    {
      offset = candidateIndex + 1
      continue
    }
  }

  return { statelessQueryData, statefulQueryData, pending: '' }
}

function containsCsiRendererQuery(data: string): boolean {
  let offset = data.indexOf('\x1b[')
  while (offset !== -1) {
    const finalByteIndex = findCsiFinalByteIndex(data, offset + 2)
    if (finalByteIndex === -1) {
      return false
    }
    const sequence = data.slice(offset, finalByteIndex + 1)
    if (isStatelessRendererReplyCsiQuery(sequence) || isStatefulRendererReplyCsiQuery(sequence)) {
      return true
    }
    offset = data.indexOf('\x1b[', finalByteIndex + 1)
  }
  return false
}

function containsStatefulRendererQuery(data: string): boolean {
  let offset = data.indexOf('\x1b[')
  while (offset !== -1) {
    const finalByteIndex = findCsiFinalByteIndex(data, offset + 2)
    if (finalByteIndex === -1) {
      return false
    }
    const sequence = data.slice(offset, finalByteIndex + 1)
    if (isStatefulRendererReplyCsiQuery(sequence)) {
      return true
    }
    offset = data.indexOf('\x1b[', finalByteIndex + 1)
  }
  return false
}

function findCsiFinalByteIndex(data: string, offset: number): number {
  for (let index = offset; index < data.length; index++) {
    const code = data.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) {
      return index
    }
  }
  return -1
}

function isStatelessRendererReplyCsiQuery(sequence: string): boolean {
  if (sequence.endsWith('c')) {
    return true
  }
  return (
    sequence === '\x1b[5n' ||
    sequence === '\x1b[>q' ||
    sequence === '\x1b[14t' ||
    sequence === '\x1b[16t'
  )
}

function isStatefulRendererReplyCsiQuery(sequence: string): boolean {
  return sequence === '\x1b[6n' || (sequence.startsWith('\x1b[?') && sequence.endsWith('$p'))
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
}

function isAgentTaskCompleteNotificationEnabled(): boolean {
  return isAgentTaskCompleteNotificationEnabledFromState(useAppStore.getState())
}

function isAgentTaskCompleteNotificationEnabledFromState(
  state: ReturnType<typeof useAppStore.getState>
): boolean {
  const notifications = state.settings?.notifications
  return notifications?.enabled !== false && notifications?.agentTaskComplete !== false
}

function isTerminalAttentionEnabledFromState(
  state: ReturnType<typeof useAppStore.getState>
): boolean {
  return state.settings?.experimentalTerminalAttention === true
}

function isAgentTaskCompleteTrackingEnabled(): boolean {
  const state = useAppStore.getState()
  return (
    isAgentTaskCompleteNotificationEnabledFromState(state) ||
    isTerminalAttentionEnabledFromState(state)
  )
}

function isAgentTaskCompleteTrackingEnabledFromState(
  state: ReturnType<typeof useAppStore.getState>
): boolean {
  return (
    isAgentTaskCompleteNotificationEnabledFromState(state) ||
    isTerminalAttentionEnabledFromState(state)
  )
}

const agentTaskCompleteTrackingEnabledListeners = new Set<() => void>()
let agentTaskCompleteTrackingSettingsUnsubscribe: (() => void) | null = null
let agentTaskCompleteTrackingSettingsSnapshot: string | null = null

function getAgentTaskCompleteTrackingSettingsSnapshot(
  state: ReturnType<typeof useAppStore.getState>
): string {
  return `${isAgentTaskCompleteTrackingEnabledFromState(state)}:${isAgentTaskCompleteNotificationEnabledFromState(state)}`
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

function hasAgentNotificationDetail(entry: AgentStatusEntry | undefined): boolean {
  return Boolean(
    entry &&
    Date.now() - entry.updatedAt <= AGENT_TASK_COMPLETE_NOTIFICATION_DETAIL_MAX_AGE_MS &&
    (entry.lastAssistantMessage || entry.toolName || entry.toolInput)
  )
}

function canDispatchAgentNotificationAfterGrace(
  entry: AgentStatusEntry | undefined,
  options: { allowDoneDetailAfterGrace?: boolean } = {}
): boolean {
  // Why: hook-backed goal/mission loops can report `done` between milestones.
  // User-input states may notify as soon as detail arrives, but `done` waits
  // for the max quiet window so resumed work can cancel the pending banner.
  return (
    hasAgentNotificationDetail(entry) &&
    (entry?.state !== 'done' || options.allowDoneDetailAfterGrace === true)
  )
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
  return document.visibilityState === 'visible'
}

function containsSynchronizedOutputStart(data: string): boolean {
  return data.includes('\x1b[?2026h')
}

function containsSynchronizedOutputEnd(data: string): boolean {
  return data.includes('\x1b[?2026l')
}

function shouldSynchronizedOutputRemainActive(data: string, wasActive: boolean): boolean {
  const lastStartIndex = data.lastIndexOf('\x1b[?2026h')
  const lastEndIndex = data.lastIndexOf('\x1b[?2026l')
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

export function connectPanePty(
  pane: ManagedPane,
  manager: PaneManager,
  deps: PtyConnectionDeps
): PanePtyBinding {
  exposeE2eTerminalPtyOutputDebug()
  let disposed = false
  let connectFrame: number | null = null
  let unregisterBacklogRecovery: (() => void) | null = null
  let unregisterDocumentVisibilityRecovery: (() => void) | null = null
  let cleanupHiddenOutputRestoreDeferredRetry = (): void => {}
  let unregisterE2ePtyDataInjection = (): void => {}
  let startupInjectTimer: ReturnType<typeof setTimeout> | null = null
  let sshShellReadyFallbackTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteNotificationGraceTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteNotificationMaxTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteStatusUnsubscribe: (() => void) | null = null
  let agentTaskCompleteSettingsUnsubscribe: (() => void) | null = null
  let agentTaskCompleteNotificationGeneration = 0
  let wasAgentTaskCompleteTrackingEnabled = isAgentTaskCompleteTrackingEnabled()
  let wasAgentTaskCompleteOsNotificationEnabled = isAgentTaskCompleteNotificationEnabled()
  let terminalBellNotificationTimer: ReturnType<typeof setTimeout> | null = null
  let pendingTerminalBellNotification = false
  let reattachIdleAgentCursorResetTimer: ReturnType<typeof setTimeout> | null = null
  let synchronizedForegroundOutputActive = false
  // Why: idle callbacks are registered before the deferred PTY output plumbing
  // exists. Start with the shared scheduler, then switch to the PTY writer
  // below so hidden-tab resets keep backlog-recovery callbacks and byte order.
  let queueAgentIdleCursorReset = (): void => {
    if (disposed) {
      return
    }
    writeTerminalOutput(pane.terminal, RESET_TERMINAL_CURSOR_STYLE, {
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
      legacyMatches.map(([, record]) =>
        [
          record.worktreeId,
          record.agent,
          record.providerSession.key,
          record.providerSession.id
        ].join('\0')
      )
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
        record.providerSession.key === consumed.record.providerSession.key &&
        record.providerSession.id === consumed.record.providerSession.id
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
      return
    }
    useAppStore.getState().registerAgentLaunchConfig(cacheKey, effectiveLaunchConfig, {
      agentType:
        metadata?.launchAgent ?? paneStartup?.launchAgent ?? paneStartup?.initialAgentStatus?.agent,
      ...((metadata?.launchToken ?? launchToken)
        ? { launchToken: metadata?.launchToken ?? launchToken }
        : {}),
      tabId: deps.tabId,
      leafId: pane.leafId
    })
  }
  const pendingSpawnKey = cacheKey
  const neutralTerminalTitle = (): string => {
    const state = useAppStore.getState()
    const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find(
      (entry) => entry.id === deps.tabId
    )
    return tab?.defaultTitle?.trim() || 'Terminal'
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
      queueAgentIdleCursorReset()
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
  const commandLifecycle = createTerminalCommandLifecycle({
    onCommandFinished: () => {
      const state = useAppStore.getState()
      const entry = state.agentStatusByPaneKey[cacheKey]
      const inferenceResult = flushPendingInterruptInference()
      if (inferenceResult === true) {
        // Why: OSC 133 D means the foreground shell command exited. If an
        // interrupt was inferred first, drop only when the current interrupted
        // row is still the same turn; otherwise a killed OpenCode CLI leaves a
        // stale "interrupted" row even though the process is gone.
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
      // Why: OSC 133 D marks the foreground shell command exiting. Remove the
      // row without retaining a done snapshot; this section represents a live
      // agent process, and the shell prompt means that process is gone.
      dropCommandFinishedStatusIfSameTurn(entry)
    }
  })
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
  }
  const clearPanePtyFitBinding = (): void => {
    // Why: fit bindings live in a module-level map, so pane teardown must
    // clear them explicitly instead of relying on DOM removal.
    bindPanePtyId(pane.id, null, deps.tabId)
    delete pane.container.dataset.ptyId
  }

  const agentCompletionCoordinator = createAgentCompletionCoordinator({
    paneKey: cacheKey,
    getPtyId: () => transport.getPtyId(),
    getSettings: () => useAppStore.getState().settings,
    inspectProcess: inspectRuntimeTerminalProcess,
    dispatchCompletion: (title, meta) =>
      scheduleAgentTaskCompleteNotification(title, {
        allowDoneDetailAfterGrace: meta?.quietedHookDone,
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      }),
    shouldPollProcessCadence: () =>
      isAgentTaskCompleteTrackingEnabled() && deps.isVisibleRef.current,
    isLive: () => {
      if (disposed) {
        return false
      }
      if (transport.getPtyId()) {
        return true
      }
      return (useAppStore.getState().ptyIdsByTabId[deps.tabId] ?? []).length > 0
    }
  })

  const onExit = (ptyId: string): void => {
    agentCompletionCoordinator.dispose()
    clearPanePtyFitBinding()
    deps.syncPanePtyLayoutBinding(pane.id, null)
    deps.clearRuntimePaneTitle(deps.tabId, pane.id)
    deps.clearTabPtyId(deps.tabId, ptyId)
    // Why: if the PTY exits abruptly (Ctrl-D, crash, shell termination) without
    // first emitting a non-agent title, the cache timer would persist as stale
    // state. Clear it unconditionally on PTY exit.
    deps.setCacheTimerStartedAt(cacheKey, null)
    // Why: a dead terminal has no running agent — remove its explicit status
    // entry so the hover UI only shows what is running *now*.
    useAppStore.getState().removeAgentStatus(cacheKey)
    // The runtime graph is the CLI's source for live terminal bindings, so
    // we must republish when a pane loses its PTY instead of waiting for a
    // broader layout change that may never happen.
    scheduleRuntimeGraphSync()
    // Why: intentional restarts suppress the PTY exit ahead of time so the
    // pane stays mounted and can reconnect in place. Without consuming the
    // suppression here, split-pane Codex restarts would still close the pane
    // because this handler runs before the tab-level close logic sees the exit.
    if (deps.consumeSuppressedPtyExit(ptyId)) {
      manager.setPaneGpuRendering(pane.id, true)
      return
    }
    manager.setPaneGpuRendering(pane.id, true)
    const panes = manager.getPanes()
    if (panes.length <= 1) {
      deps.onPtyExitRef.current(ptyId)
      return
    }
    if (
      hadExistingPaneTransportAtConnect &&
      !restoredPtyIdForTransport &&
      !Number.isFinite(lastTerminalInputAt) &&
      !hasReceivedPtyOutput
    ) {
      // Why: a freshly split pane can lose its newborn PTY during setup; keep
      // the split visible so the failed session does not immediately collapse.
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

  const onTitleChange = (title: string, rawTitle: string): void => {
    manager.setPaneGpuRendering(pane.id, !isGeminiTerminalTitle(rawTitle))
    deps.setRuntimePaneTitle(deps.tabId, pane.id, title)
    if (syncAgentTaskCompleteTrackingEnabled()) {
      agentCompletionCoordinator.observeTitle(rawTitle)
    }
    // Why: only the focused pane should drive the tab title — otherwise two
    // agents in split panes cause rapid title flickering as each emits OSC
    // sequences. Only the active split's title propagates to the tab. When
    // focus changes, onActivePaneChange syncs the newly active pane's stored
    // title to the tab.
    if (manager.getActivePane()?.id === pane.id) {
      deps.updateTabTitle(deps.tabId, title)
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
    if (!initialStatus) {
      return
    }
    const statusPayload = {
      state: 'working' as const,
      prompt: initialStatus.prompt,
      agentType: initialStatus.agent
    }
    if (paneStartup.launchConfig) {
      useAppStore
        .getState()
        .setAgentStatus(cacheKey, statusPayload, terminalTitle, undefined, undefined, {
          launchConfig: paneStartup.launchConfig,
          ...(launchToken ? { launchToken } : {})
        })
      return
    }
    useAppStore.getState().setAgentStatus(cacheKey, statusPayload, terminalTitle)
  }

  const seedCommandCodeOutputWorkingStatus = (prompt: string): void => {
    clearCommandCodeOutputDoneTimer()
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
      currentTitle
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
        currentTitle
      )
    }, COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)
  }

  const commandCodeOutputStatusDetector = createCommandCodeOutputStatusDetector({
    startupCommand: paneStartup?.command,
    onWorking: seedCommandCodeOutputWorkingStatus,
    onDone: scheduleCommandCodeOutputDoneStatus
  })
  const observeTerminalGitHubPRLink = createTerminalGitHubPRLinkDetector()

  const onPtySpawn = (ptyId: string): void => {
    setPanePtyFitBinding(ptyId)
    deps.syncPanePtyLayoutBinding(pane.id, ptyId)
    deps.updateTabPtyId(deps.tabId, ptyId)
    // Why: Command Code has no prompt-start hook. Seed the visible working row
    // once the PTY exists, then let real hook events refine or complete it.
    applyInitialAgentStatus()
    // Spawn completion is when a pane gains a concrete PTY ID. The initial
    // frame-level sync often runs before that async result arrives.
    scheduleRuntimeGraphSync()
    agentCompletionCoordinator.startProcessTracking()
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
      // Drop pending timers and coordinator state so old work cannot replay.
      agentTaskCompleteNotificationGeneration += 1
      clearPendingAgentTaskCompleteNotification()
      agentCompletionCoordinator.resetCompletionState({ requireFreshWorking: true })
      if (pendingTerminalBellNotification) {
        scheduleTerminalBellNotification()
      }
    } else if (enabled && !wasAgentTaskCompleteTrackingEnabled) {
      // Why: a pane may have observed work while all completion consumers were
      // disabled. Re-enabling should not let the next idle event report old work.
      agentCompletionCoordinator.resetCompletionState({ requireFreshWorking: true })
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
    } = {}
  ): void => {
    if (!syncAgentTaskCompleteTrackingEnabled()) {
      return
    }
    clearPendingAgentTaskCompleteNotification()
    let graceElapsed = false
    const generationAtSchedule = agentTaskCompleteNotificationGeneration

    const dispatch = (): void => {
      clearPendingAgentTaskCompleteNotification()
      if (
        generationAtSchedule !== agentTaskCompleteNotificationGeneration ||
        !syncAgentTaskCompleteTrackingEnabled()
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
        ...(shouldDispatchOsNotification ? {} : { suppressOsNotification: true }),
        ...(options.agentStatusSnapshot ? { agentStatusSnapshot: options.agentStatusSnapshot } : {})
      })
    }

    const dispatchIfDetailed = (): void => {
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
  const onAgentBecameIdle = (title: string): void => {
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
    const settings = useAppStore.getState().settings
    if (isClaudeAgent(title) && (settings === null || settings.promptCacheTimerEnabled)) {
      deps.setCacheTimerStartedAt(cacheKey, Date.now())
    }
    if (syncAgentTaskCompleteTrackingEnabled()) {
      agentCompletionCoordinator.observeClassifiedTitleCompletion(title)
    }
    // Why: some agent TUIs leave xterm in DECSCUSR steady-cursor mode when
    // they become idle. Reset to Orca's configured cursor once the turn ends.
    queueAgentIdleCursorReset()
  }
  const onAgentBecameWorking = (): void => {
    if (syncAgentTaskCompleteTrackingEnabled()) {
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
  const connectionId = getConnectionId(deps.worktreeId) ?? null
  const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find((t) => t.id === deps.tabId)
  const shellOverride = tab?.shellOverride
  const isNativeWindowsConpty = isLocalNativeWindowsPty({
    userAgent: navigator.userAgent,
    connectionId,
    cwd: deps.cwd,
    shellOverride
  })
  const shouldApplyNativeWindowsRewriteRefresh = isNativeWindowsConpty
  const shouldProtectNativeWindowsSynchronizedOutput = isNativeWindowsConpty

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
  const shouldDeliverStartupViaTerminalPaste = paneStartup?.delivery === 'terminal-paste'
  const hadExistingPaneTransportAtConnect = deps.paneTransportsRef.current.size > 0
  let lastTerminalInputAt = Number.NEGATIVE_INFINITY
  let hasReceivedPtyOutput = false
  const markTerminalInputSent = (): void => {
    lastTerminalInputAt = performance.now()
  }
  const recordAcceptedTerminalInputForHibernation = (): void => {
    useAppStore.getState().recordTerminalInput(cacheKey)
  }
  const markAcceptedTerminalInputSent = (): void => {
    markTerminalInputSent()
    recordAcceptedTerminalInputForHibernation()
  }
  const transportOptions = {
    cwd: deps.cwd,
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
    ...(paneStartup?.launchConfig ? { launchConfig: paneStartup.launchConfig } : {}),
    ...(launchToken ? { launchToken } : {}),
    ...(paneStartup?.launchAgent ? { launchAgent: paneStartup.launchAgent } : {}),
    ...(paneStartup?.telemetry ? { telemetry: paneStartup.telemetry } : {}),
    onPtyExit: onExit,
    onTitleChange,
    onPtySpawn,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    // Why: local IPC terminals are now model-owned in main: OrcaRuntimeService
    // parses OSC 9999 before renderer delivery and forwards through the hook
    // server with local/SSH identity. Remote-runtime streams do not pass through
    // local main, so the renderer remains their status owner for now.
    ...(shouldOwnAgentStatusInRenderer
      ? {
          onAgentStatus: (payload) => {
            // Why: capture the store snapshot once so the title lookup and the
            // setAgentStatus call observe the same state. Re-reading getState()
            // between the two lines opens a brief window where the title could
            // shift (OSC title update landing in between) and the status would
            // be stored against a title that was never paired with it.
            const currentState = useAppStore.getState()
            const title = currentState.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
            const statusTitle = resolveAgentStatusTerminalTitle(payload, title)
            if (launchToken) {
              currentState.setAgentStatus(cacheKey, payload, statusTitle, undefined, undefined, {
                launchToken
              })
            } else {
              currentState.setAgentStatus(cacheKey, payload, statusTitle)
            }
            if (syncAgentTaskCompleteTrackingEnabled()) {
              const storedStatus = useAppStore.getState().agentStatusByPaneKey[cacheKey]
              const notificationPayload =
                typeof storedStatus?.stateStartedAt === 'number'
                  ? { ...payload, stateStartedAt: storedStatus.stateStartedAt }
                  : payload
              agentCompletionCoordinator.observeHookStatus(notificationPayload)
            }
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
  deps.paneTransportsRef.current.set(pane.id, transport)
  const terminalCapabilityRepliesDisposable = installTerminalCapabilityReplyHandlers({
    terminal: pane.terminal,
    parser: pane.terminal.parser,
    sendInput: (data) => transport.sendInput(data),
    isReplaying: () => isPaneReplaying(deps.replayingPanesRef, pane.id),
    ...(isNativeWindowsConpty ? { da1Response: CONPTY_DA1_RESPONSE } : {})
  })
  const respondToTerminalPixelSizeQueries = createTerminalPixelSizeQueryResponder(
    pane.terminal,
    (data) => transport.sendInput(data)
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
    const intent = pendingTerminalInputIntent
    // Why: real xterm can deliver the terminal byte even when our DOM keydown
    // listener missed the press. Exact Ctrl+C/Escape bytes are still safe to
    // infer for local/remote acknowledged writes; SSH fire-and-forget remains
    // excluded because those transports do not expose sendInputAccepted.
    const acknowledgedIntent = intent ?? inferIntentFromExactTerminalInput(data)
    if (acknowledgedIntent && transport.sendInputAccepted) {
      clearPendingTerminalInputIntent()
      markTerminalInputSent()
      const writePromise = transport
        .sendInputAccepted(data)
        .then((accepted) => {
          if (accepted) {
            recordAcceptedTerminalInputForHibernation()
            observeAcceptedTerminalInput(data, acknowledgedIntent)
            interruptInference.observeInputIntent(acknowledgedIntent)
            observeTitleOnlyInterrupt()
          }
        })
        .catch((err) => {
          console.warn('[agent-interrupt] acknowledged terminal input failed:', err)
        })
      setPendingTerminalInputWrite(writePromise)
      return
    }
    if (intent) {
      if (transport.sendInput(data)) {
        markAcceptedTerminalInputSent()
        observeAcceptedTerminalInput(data, intent)
      }
      clearPendingTerminalInputIntent()
      return
    }
    if (transport.sendInput(data)) {
      markAcceptedTerminalInputSent()
      observeAcceptedTerminalInput(data)
      observeSentTerminalInputIntent(data)
    } else {
      clearPendingTerminalInputIntent()
    }
  })

  const shouldSuppressDesktopPtyResize = (): boolean => {
    const currentPtyId = transport.getPtyId()
    return Boolean(
      currentPtyId && (getFitOverrideForPty(currentPtyId) || isPtyLocked(currentPtyId))
    )
  }

  const forwardPtyResize = (cols: number, rows: number): void => {
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
    transport.resize(cols, rows)
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
    if (shouldSuppressDesktopPtyResize()) {
      return
    }
    if (queuePanePtyResizeIfHeld(pane.container, cols, rows)) {
      return
    }
    transport.resize(cols, rows)
  })

  // Why: while a mobile-fit override is active, the onResize listener above
  // and the matching server-side gate both correctly drop pty:resize so the
  // PTY stays parked at phone dims. But the server still needs to learn the
  // real desktop pane geometry — otherwise resolveDesktopRestoreTarget falls
  // back to the PTY's spawn default (e.g. 80×24 for a hidden tab) and Take
  // Back leaves the terminal partially restored. This observer measures the
  // pane container as a side-channel, computes proposed cols/rows the way
  // safeFit would, and reports it via pty:reportGeometry — a measurement-
  // only IPC that updates lastRendererSizes and non-null subscriber
  // baselines without resizing the PTY. We only fire while an override is
  // active because the normal pty:resize path covers all other cases. See
  // docs/mobile-fit-hold.md.
  let pendingGeometryReportRaf: number | null = null
  const reportPaneGeometry = (): void => {
    pendingGeometryReportRaf = null
    const currentPtyId = transport.getPtyId()
    if (!currentPtyId) {
      return
    }
    if (!getFitOverrideForPty(currentPtyId)) {
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
          if (pendingGeometryReportRaf !== null) {
            return
          }
          pendingGeometryReportRaf = requestAnimationFrame(reportPaneGeometry)
        })
  // Why: pane.xtermContainer is created later in pane-lifecycle's
  // attachWebgl/initial-fit path; pane.container is always present at the
  // moment connectPanePty runs (it's the .pane element). Both report the
  // same layout signal — when the outer pane resizes, the inner xterm
  // container resizes too — so this is the safe element to observe.
  if (geometryReportObserver && pane.container instanceof Element) {
    geometryReportObserver.observe(pane.container)
  }
  // Defer PTY spawn/attach to next frame so FitAddon has time to calculate
  // the correct terminal dimensions from the laid-out container.
  connectFrame = requestAnimationFrame(() => {
    connectFrame = null
    if (disposed) {
      return
    }
    safeFit(pane)
    const cols = pane.terminal.cols
    const rows = pane.terminal.rows

    // Why: if fitAddon resolved to 0×0, the container likely has no layout
    // dimensions (display:none, unmounted, or zero-size parent). Surface a
    // diagnostic so the user sees something instead of a blank pane.
    if (cols === 0 || rows === 0) {
      deps.onPtyErrorRef?.current?.(
        pane.id,
        `Terminal has zero dimensions (${cols}×${rows}). The pane container may not be visible.`
      )
    }

    const reportError = (message: string): void => {
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
            await waitForTerminalOutputParsed(pane.terminal)
            // Why: alt-screen TUIs (vim, claude-code) hold transient state in
            // the alternate screen. The hydration path requests
            // altScreenForcesZeroRows so normal-buffer scrollback isn't bled
            // into the seed when the user is mid-TUI; the read-fallback path
            // omits it because it wants the user's currently-visible content.
            const alt = pane.terminal.buffer.active.type === 'alternate'
            const data =
              opts?.altScreenForcesZeroRows && alt
                ? pane.serializeAddon.serialize({ scrollback: 0 })
                : pane.serializeAddon.serialize({ scrollback: opts?.scrollbackRows })
            return {
              data,
              cols: pane.terminal.cols,
              rows: pane.terminal.rows
            }
          } catch {
            return null
          }
        },
        () => {
          clearHiddenOutputRestoreState()
          discardTerminalOutput(pane.terminal)
          pane.terminal.clear()
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

    // Why: for ordinary local startup commands, the local PTY provider already
    // writes via the shell-ready barrier. terminal-paste and SSH startup
    // commands stay renderer-delivered so xterm/relay can apply their handling.
    let pendingStartupCommand: PendingStartupCommand | null =
      shouldDeliverStartupViaTerminalPaste || connectionId
        ? paneStartup?.command
          ? { command: paneStartup.command }
          : null
        : null
    const shouldWaitForSshShellReady =
      Boolean(connectionId) &&
      shouldUseShellReadyStartupDelivery({
        command: paneStartup?.command,
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
            sleepingRecord.providerSession.key === providerSession.key &&
            sleepingRecord.providerSession.id === providerSession.id))
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
      if (startup.hasSleepingRecord) {
        showSessionRestoredBanner()
      }
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
      startup: ColdRestoreAgentResumeStartup | null = buildColdRestoreAgentResumeStartup()
    ): void => {
      applyColdRestoreAgentResumeStartup(startup)
      startFreshSpawn(startup)
    }
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
          if (shouldDeliverStartupViaTerminalPaste) {
            await runTerminalPasteStartupCommand(command)
          } else {
            transport.sendInput(`${command}\r`)
          }
          pendingStartupCommand = null
        })()
      }, 50)
    }

    const startFreshSpawn = (startupOverride?: PendingStartupCommand | null): void => {
      clearPaneMode2031State()
      clearHiddenOutputRestoreState()
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
        callbacks: {
          onData: dataCallback,
          onReplayData: replayDataCallback,
          onError: reportError
        }
      })

      const trackedPromise: Promise<string | null> = Promise.resolve(spawnedRaw)
        .then(async (spawnedPtyId) => {
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
            clearSleepingRecordAfterColdRestoreSpawn(coldRestoreOverride)
          }
          const gen = await preSignalPromise
          if (typeof gen === 'number' && resolvedPtyId) {
            if (!isRemoteRuntimePtyId(resolvedPtyId)) {
              registerPaneSerializerFor(resolvedPtyId)
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
    }

    let foregroundRefreshRiskScanTail = ''

    function trailingIncompleteCsiSequence(data: string): string {
      const escapeIndex = data.lastIndexOf('\x1b[')
      if (escapeIndex === -1) {
        return ''
      }
      const tail = data.slice(escapeIndex)
      for (let index = 2; index < tail.length; index++) {
        const code = tail.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) {
          return ''
        }
      }
      return tail.slice(-TERMINAL_RENDERER_RISK_SCAN_TAIL_CHARS)
    }

    function foregroundAnsiOutputPrefersRenderRefresh(data: string): boolean {
      if (!data) {
        return false
      }
      const scanData = foregroundRefreshRiskScanTail
        ? `${foregroundRefreshRiskScanTail}${data}`
        : data
      const prefersRefresh =
        scanData.includes('\x1b[') && terminalOutputPrefersRenderRefresh(scanData)
      foregroundRefreshRiskScanTail = trailingIncompleteCsiSequence(scanData)
      return prefersRefresh
    }

    // The replay path uses the guard so xterm auto-replies to embedded query
    // sequences don't leak into the shell. xterm.write() buffers internally
    // regardless of DOM visibility and the guard stays engaged via the
    // write-completion callback until xterm finishes parsing.
    const writeReplayData = (data: string): void => {
      // Why: drain any queued background bytes BEFORE the replay paint, so the
      // scheduler's deferred drain cannot land older bytes on top of the replay.
      flushTerminalOutput(pane.terminal)
      replayIntoTerminal(pane, deps.replayingPanesRef, data)
    }

    const writeReplayDataAsync = (data: string): Promise<void> => {
      // Why: WebGL must be rebuilt after xterm has parsed replay bytes, not
      // merely after the write was queued.
      flushTerminalOutput(pane.terminal)
      return replayIntoTerminalAsync(pane, deps.replayingPanesRef, data)
    }

    const replayDataCallback = (data: string): void => {
      void (async () => {
        // Relay replay buffer holds the last 100 KB of output, which may
        // overlap with content already rendered in xterm before the
        // disconnect. Clear first to prevent duplication on SSH reconnect.
        await writeReplayDataAsync('\x1b[2J\x1b[3J\x1b[H')
        await writeReplayDataAsync(data)
        await writeReplayDataAsync(POST_REPLAY_REATTACH_RESET)
        if (disposed) {
          return
        }
        // Why: remote-runtime snapshots can arrive after WebGL attached to an
        // empty buffer; rebuilding after replay parses seeds the glyph atlas
        // from the now-populated xterm state.
        manager.rebuildPaneWebgl(pane.id)
      })()
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
    let hiddenOutputRestoreDeferredRetryAttempts = 0
    // Why: hidden recovery state belongs to one PTY stream. Reattach/restart
    // can reuse the pane object for a different session before visibility.
    let hiddenOutputRestorePtyId: string | null = null
    let hiddenOutputRestoreGeneration = 0
    let foregroundImmediateBudgetChars = 0
    let foregroundImmediateBudgetWindowStart = 0
    let hiddenMode2031ScanTail = ''
    const shouldSnapshotHiddenCodexOutput = shouldKeepHiddenStartupRendererQueriesLive(paneStartup)
    let hiddenStartupRendererQueryPending = ''
    let hiddenRendererStateDirty = false

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
      // mode 2031 out-of-band so TUIs still render the snapshot with the same
      // theme-dependent styling they would have used in a visible pane.
      deps.paneMode2031Ref.current.set(pane.id, true)
      transport.sendInput(mode2031SequenceFor(mode))
      deps.paneLastThemeModeRef.current.set(pane.id, mode)
      recordHiddenMode2031Reply()
    }
    function beforeTerminalOutputWrite(): void {
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
      if (data.includes('\r') || data.includes('\b')) {
        return true
      }
      let escapeIndex = data.indexOf('\x1b[')
      while (escapeIndex !== -1) {
        for (let index = escapeIndex + 2; index < data.length; index++) {
          const char = data[index]
          if (char >= '0' && char <= '9') {
            continue
          }
          if (char === ';' || char === '?') {
            continue
          }
          if (char === 'J' || char === 'K') {
            return true
          }
          break
        }
        escapeIndex = data.indexOf('\x1b[', escapeIndex + 2)
      }
      return false
    }

    function shouldForceForegroundRenderRefresh(data: string): boolean {
      if (foregroundAnsiOutputPrefersRenderRefresh(data)) {
        // Why: Codex-style background SGR panels can paint cell fills while
        // glyphs lag behind; refresh only renderer-risk ANSI chunks, not all output.
        return true
      }
      return (
        shouldApplyNativeWindowsRewriteRefresh &&
        containsNonAsciiOutput(data) &&
        containsWindowsRewriteControl(data)
      )
    }

    function writePtyOutputToXterm(
      data: string,
      foreground: boolean,
      opts?: { hiddenStartupRendererQuery?: boolean }
    ): void {
      if (foreground) {
        resetHiddenOutputRestoreIfPtyChanged()
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
      synchronizedForegroundOutputActive = nextSynchronizedForegroundOutputActive
      if (hiddenMode2031ScanTail) {
        respondToSkippedMode2031Subscribe(data)
      }
      writeTerminalOutput(pane.terminal, data, {
        foreground: foreground || parseHiddenStartupOutput,
        beforeWrite: beforeTerminalOutputWrite,
        onBackgroundBacklogDropped: markHiddenOutputRestoreNeeded,
        latencySensitive:
          !foreground || parseHiddenStartupOutput ? true : isLatencySensitiveForegroundOutput(data),
        forceForegroundRefresh:
          (foreground || parseHiddenStartupOutput) &&
          (synchronizedForegroundOutput ||
            nativeWindowsCursorRestore ||
            shouldForceForegroundRenderRefresh(data)),
        followupForegroundRefresh: nativeWindowsCursorRestore,
        stripTransientCursorShows: shouldProtectNativeWindowsSynchronizedOutput && foreground,
        coalesceForeground: synchronizedForegroundOutput && synchronizedOutputEnded,
        holdForeground: synchronizedForegroundOutput && nextSynchronizedForegroundOutputActive
      })
    }

    queueAgentIdleCursorReset = (): void => {
      if (disposed) {
        return
      }
      writePtyOutputToXterm(
        RESET_TERMINAL_CURSOR_STYLE,
        shouldWritePtyOutputForeground(deps.isVisibleRef.current)
      )
    }

    function markHiddenOutputRestoreNeeded(): void {
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
      remainingData: string
      consumedCurrentChars: number
    } {
      const pending = hiddenStartupRendererQueryPending
      hiddenStartupRendererQueryPending = ''
      if (!pending) {
        return {
          statelessQueryData: '',
          statefulQueryData: '',
          remainingData: data,
          consumedCurrentChars: 0
        }
      }

      const input = pending + data
      let statelessQueryData = ''
      let statefulQueryData = ''
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
        const matchingPrefix = HIDDEN_STARTUP_OSC_COLOR_QUERY_PREFIXES.find((prefix) =>
          input.startsWith(prefix)
        )
        const terminatorIndex = findOscTerminatorIndex(input, 2)
        if (
          !matchingPrefix &&
          HIDDEN_STARTUP_OSC_COLOR_QUERY_PREFIXES.some((prefix) => prefix.startsWith(input))
        ) {
          nextPending = input
          consumedInputChars = input.length
        } else if (terminatorIndex === -1) {
          nextPending = input.slice(0, HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS)
          consumedInputChars = input.length
        } else {
          if (matchingPrefix) {
            statelessQueryData = input.slice(0, terminatorIndex)
          }
          consumedInputChars = terminatorIndex
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
      if (hiddenOutputRestorePendingChars + data.length > HIDDEN_OUTPUT_RESTORE_PENDING_CHARS) {
        hiddenOutputRestorePendingChunks = []
        hiddenOutputRestorePendingChars = 0
        hiddenOutputRestorePendingOverflow = true
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

    function drainPendingLiveChunksAfterSnapshot(snapshotSeq: number | undefined): boolean {
      if (hiddenOutputRestorePendingOverflow) {
        hiddenOutputRestorePendingOverflow = false
        hiddenOutputRestorePendingChunks = []
        hiddenOutputRestorePendingChars = 0
        return false
      }
      while (hiddenOutputRestorePendingChunks.length > 0) {
        const chunks = hiddenOutputRestorePendingChunks
        hiddenOutputRestorePendingChunks = []
        hiddenOutputRestorePendingChars = 0
        for (const chunk of chunks) {
          const data = getChunkDataAfterSnapshot(chunk, snapshotSeq)
          if (data === null) {
            // Why: renderer-only OSC stripping makes raw sequence offsets
            // impossible to map onto cleaned text. Fetch a fresher main
            // snapshot instead of risking duplicate visible output.
            hiddenOutputRestorePendingChunks = []
            hiddenOutputRestorePendingChars = 0
            return false
          }
          if (data) {
            writePtyOutputToXterm(data, true)
          }
        }
        if (hiddenOutputRestorePendingOverflow) {
          hiddenOutputRestorePendingOverflow = false
          hiddenOutputRestorePendingChunks = []
          hiddenOutputRestorePendingChars = 0
          return false
        }
      }
      return true
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

    function scheduleHiddenOutputRestoreDeferredRetry(): void {
      if (
        disposed ||
        hiddenOutputRestoreDeferredRetryTimer !== null ||
        !shouldWritePtyOutputForeground(deps.isVisibleRef.current)
      ) {
        return
      }
      if (hiddenOutputRestoreDeferredRetryAttempts >= HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MAX) {
        clearHiddenOutputRestoreState()
        writeRestoreUnavailableWarning()
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
      clearPendingLiveChunksDuringRestore()
      hiddenStartupRendererQueryPending = ''
      hiddenRendererStateDirty = false
      hiddenOutputRestoreNeeded = false
      hiddenOutputRestorePtyId = null
      hiddenOutputRestoreGeneration += 1
    }

    function clearPaneMode2031State(): void {
      deps.paneMode2031Ref.current.delete(pane.id)
      deps.paneLastThemeModeRef.current.delete(pane.id)
    }

    function resetHiddenOutputRestoreIfPtyChanged(): void {
      if (hiddenOutputRestorePtyId === null) {
        return
      }
      if (transport.getPtyId() !== hiddenOutputRestorePtyId) {
        // Why: renderer backlog is tied to the old PTY stream; after reattach,
        // queued hidden bytes must not delay or replay before the new PTY.
        clearHiddenOutputRestoreState()
        clearPaneMode2031State()
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

    function captureScrollStateForSnapshotReplay(): ScrollState | null {
      const buf = pane.terminal.buffer?.active
      if (!buf) {
        return null
      }
      const viewportY = buf.viewportY
      const baseY = buf.baseY
      if (!Number.isFinite(viewportY) || !Number.isFinite(baseY)) {
        return null
      }
      return {
        bufferType: buf.type,
        wasAtBottom: viewportY >= baseY,
        viewportY,
        baseY
      }
    }

    function restoreScrollStateAfterSnapshotReplay(state: ScrollState | null): void {
      if (!state || state.wasAtBottom) {
        return
      }
      // Why: hidden-backlog replay clears xterm after visibility scroll restore;
      // re-apply a scrolled-up viewport so recovery does not jump to bottom.
      restoreScrollStateAfterLayout(pane.terminal, state)
    }

    function applyMainBufferSnapshot(snapshot: {
      data: string
      cols: number
      rows: number
      seq?: number
    }): void {
      const scrollState = captureScrollStateForSnapshotReplay()
      discardTerminalOutput(pane.terminal)
      if (
        Number.isFinite(snapshot.cols) &&
        Number.isFinite(snapshot.rows) &&
        snapshot.cols > 0 &&
        snapshot.rows > 0 &&
        (pane.terminal.cols !== snapshot.cols || pane.terminal.rows !== snapshot.rows)
      ) {
        // Why: serialized terminal snapshots encode layout at their source
        // dimensions. Replay at those dimensions first, then fit back below.
        pane.terminal.resize(snapshot.cols, snapshot.rows)
      }
      writeReplayData('\x1b[2J\x1b[3J\x1b[H')
      writeReplayData(snapshot.data)
      writeReplayData(POST_REPLAY_LIVE_SNAPSHOT_RESET)
      hiddenRendererStateDirty = false
      recordTerminalOutput(pane.terminal)
      const currentPtyId = transport.getPtyId()
      if (currentPtyId && !getFitOverrideForPty(currentPtyId)) {
        safeFit(pane)
        transport.resize(pane.terminal.cols, pane.terminal.rows)
        if (!isRemoteRuntimePtyId(currentPtyId)) {
          window.api.pty.signal(currentPtyId, 'SIGWINCH')
        }
        scheduleReattachIdleAgentCursorReset()
      }
      restoreScrollStateAfterSnapshotReplay(scrollState)
    }

    function requestHiddenOutputRestoreIfNeeded(opts?: { bypassScheduler?: boolean }): boolean {
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
              scrollbackRows: HIDDEN_OUTPUT_RESTORE_SCROLLBACK_ROWS
            })
          } catch {
            snapshot = null
          }
          if (disposed) {
            return
          }
          if (
            hiddenOutputRestoreGeneration !== restoreGeneration ||
            transport.getPtyId() !== currentPtyId ||
            hiddenOutputRestorePtyId !== currentPtyId
          ) {
            // Why: the snapshot belongs to the requested PTY; after reattach,
            // replaying it would show stale/cleared output in the new terminal.
            if (hiddenOutputRestorePtyId === currentPtyId) {
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
          applyMainBufferSnapshot(snapshot)
          const needsFreshSnapshot = hiddenOutputRestoreFreshSnapshotNeeded
          hiddenOutputRestoreFreshSnapshotNeeded = false
          if (drainPendingLiveChunksAfterSnapshot(snapshot.seq) && !needsFreshSnapshot) {
            hiddenOutputRestoreNeeded = false
            hiddenOutputRestorePtyId = null
            return
          }
          if (!shouldWritePtyOutputForeground(deps.isVisibleRef.current)) {
            // Why: hidden bytes that arrived during the snapshot were not kept
            // in renderer memory. Leave recovery pending for the next visible
            // moment instead of looping hidden snapshots in a throttled tab.
            hiddenOutputRestoreNeeded = true
            return
          }
          hiddenOutputRestoreNeeded = true
        }
      })().finally(() => {
        hiddenOutputRestoreInFlight = null
        if (hiddenOutputRestorePendingChunks.length > 0 || hiddenOutputRestorePendingOverflow) {
          hiddenOutputRestoreNeeded = true
        }
        if (
          !hiddenOutputRestoreRetryDeferred &&
          hiddenOutputRestoreNeeded &&
          shouldWritePtyOutputForeground(deps.isVisibleRef.current)
        ) {
          requestHiddenOutputRestoreIfNeeded()
        }
      })
      return true
    }

    unregisterBacklogRecovery = registerTerminalBacklogRecovery(
      pane.terminal,
      requestHiddenOutputRestoreIfNeeded
    )
    if (
      typeof document !== 'undefined' &&
      typeof document.addEventListener === 'function' &&
      typeof document.removeEventListener === 'function'
    ) {
      const onDocumentVisibilityChange = (): void => {
        if (shouldWritePtyOutputForeground(deps.isVisibleRef.current)) {
          requestHiddenOutputRestoreIfNeeded()
        }
      }
      document.addEventListener('visibilitychange', onDocumentVisibilityChange)
      unregisterDocumentVisibilityRecovery = () =>
        document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
    }

    const dataCallback = (data: string, meta?: PtyDataMeta): void => {
      if (data.length > 0) {
        hasReceivedPtyOutput = true
        recordAgentHibernationPaneOutput(cacheKey)
      }
      if (sshShellReadyMarkerScan) {
        const scanned = scanForShellReadyMarker(sshShellReadyMarkerScan, data)
        if (scanned.matched) {
          markSshStartupShellReady()
        }
        data = scanned.output
      }
      resetHiddenOutputRestoreIfPtyChanged()
      respondToTerminalPixelSizeQueries(data)
      observeTerminalBracketedPasteModeOutput(pane.terminal, data)
      for (const link of observeTerminalGitHubPRLink(data)) {
        useAppStore.getState().observeTerminalGitHubPullRequestLink(deps.worktreeId, link)
      }
      commandCodeOutputStatusDetector.observe(data)
      commandLifecycle.handlePtyData(data)
      // Why: split-pane layouts have multiple visible-but-inactive panes whose
      // output the user is watching. Throttle only when the pane or whole
      // Electron document is hidden.
      const foreground = shouldWritePtyOutputForeground(deps.isVisibleRef.current)
      if (foreground && hiddenMode2031ScanTail) {
        respondToSkippedMode2031Subscribe(data)
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
      if (pendingForegroundQuery?.statelessQueryData) {
        writePtyOutputToXterm(pendingForegroundQuery.statelessQueryData, true, {
          hiddenStartupRendererQuery: true
        })
      }
      const restoreAppliesToCurrentPty =
        hiddenOutputRestorePtyId !== null && transport.getPtyId() === hiddenOutputRestorePtyId
      if (shouldSkipHiddenRendererOutput(foreground, data)) {
        skipHiddenRendererOutput(data)
      } else if (
        (hiddenOutputRestoreNeeded || hiddenOutputRestoreInFlight) &&
        restoreAppliesToCurrentPty
      ) {
        if (foreground) {
          if (pendingForegroundQuery?.statefulQueryData) {
            queueLiveChunkDuringRestore(pendingForegroundQuery.statefulQueryData)
          }
          queueLiveChunkDuringRestore(rendererData, rendererMeta)
          requestHiddenOutputRestoreIfNeeded()
        } else if (hiddenOutputRestoreInFlight) {
          hiddenOutputRestoreNeeded = true
          hiddenOutputRestoreFreshSnapshotNeeded = true
        }
      } else {
        if (pendingForegroundQuery?.statefulQueryData) {
          writePtyOutputToXterm(pendingForegroundQuery.statefulQueryData, true, {
            hiddenStartupRendererQuery: true
          })
        }
        writePtyOutputToXterm(rendererData, foreground)
      }

      schedulePendingStartupCommandDelivery()
    }
    unregisterE2ePtyDataInjection = registerE2eTerminalPtyDataInjection(cacheKey, (data, meta) => {
      if (!disposed) {
        dataCallback(data, meta)
      }
    })

    const handleReattachResult = (
      result: PtyConnectResult | string | void,
      staleSessionId?: string | null,
      coldRestoreStartup?: ColdRestoreAgentResumeStartup | null
    ): void => {
      if (disposed) {
        return
      }
      const connectResult =
        result && typeof result === 'object' && 'id' in result ? (result as PtyConnectResult) : null

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
        deps.syncPanePtyLayoutBinding(pane.id, null)
        if (staleSessionId) {
          deps.clearTabPtyId(deps.tabId, staleSessionId)
        }
        startFreshColdRestoreAgentResume(coldRestoreStartup)
        return
      }
      registerEffectiveLaunchConfig(connectResult?.launchConfig, {
        ...(coldRestoreStartup ? { launchToken: coldRestoreStartup.launchToken } : {}),
        ...(coldRestoreStartup ? { launchAgent: coldRestoreStartup.agent } : {})
      })
      if (connectResult?.sessionExpired) {
        deps.syncPanePtyLayoutBinding(pane.id, null)
        if (staleSessionId) {
          deps.clearTabPtyId(deps.tabId, staleSessionId)
        }
        // Why: SSH sleep/reconnect can invalidate the relay-held PTY while
        // leaving the tab mounted. Replace the dead lease in-place instead of
        // stranding the pane behind a stale expired-session overlay.
        startFreshColdRestoreAgentResume(coldRestoreStartup)
        return
      }
      setPanePtyFitBinding(ptyId)
      deps.syncPanePtyLayoutBinding(pane.id, ptyId)
      deps.updateTabPtyId(deps.tabId, ptyId)
      agentCompletionCoordinator.startProcessTracking()

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
      if (connectResult?.snapshot) {
        writeReplayData('\x1b[2J\x1b[3J\x1b[H')
        writeReplayData(connectResult.snapshot)
        // Snapshot reattach keeps a live session, so avoid the broader mode
        // reset. We only drop stale cursor/focus state that should not leak
        // from replay bytes into the restored renderer terminal.
        writeReplayData(POST_REPLAY_REATTACH_RESET)
        if (connectResult.coldRestore) {
          // Snapshot superseded the cold-restore payload — ack it so the
          // daemon does not redeliver it on the next reattach.
          if (!isRemoteRuntimePtyId(ptyId)) {
            window.api.pty.ackColdRestore(ptyId)
          }
        }
      } else if (connectResult?.replay) {
        // Relay replay holds the last 100 KB of raw output. The xterm may
        // already hold pre-disconnect content; clear first to avoid
        // duplication. The reattach reset prevents stale cursor/focus mode
        // bits in the replayed data from leaking into the restored terminal.
        writeReplayData('\x1b[2J\x1b[3J\x1b[H')
        writeReplayData(connectResult.replay)
        writeReplayData(POST_REPLAY_REATTACH_RESET)
        if (connectResult.coldRestore) {
          if (!isRemoteRuntimePtyId(ptyId)) {
            window.api.pty.ackColdRestore(ptyId)
          }
        }
      } else if (connectResult?.coldRestore) {
        // restoreScrollbackBuffers() already wrote the saved xterm buffer
        // before this rAF ran. The cold-restore scrollback overlaps with
        // that content; clear first.
        // replayIntoTerminal: the recorded scrollback is raw PTY output that
        // may contain query sequences the previous agent CLI emitted;
        // writing them through xterm.write would trigger auto-replies that
        // land in the new shell's stdin. See replay-guard.ts.
        writeReplayData('\x1b[2J\x1b[3J\x1b[H')
        writeReplayData(connectResult.coldRestore.scrollback)
        const preparedStartup = coldRestoreStartup ?? buildColdRestoreAgentResumeStartup()
        const didPrepareResume = applyColdRestoreAgentResumeStartup(preparedStartup)
        if (didPrepareResume) {
          clearSleepingRecordAfterColdRestoreSpawn(preparedStartup)
        }
        // Cold-restore means the daemon lost the session and spawned a
        // fresh shell — no TUI is consuming the mode-setting bytes that a
        // crashed TUI (e.g. Claude's \e[?1004h) left in the scrollback, so
        // reset them to match the fresh shell's expectations.
        writeReplayData(POST_REPLAY_MODE_RESET)
        if (!isRemoteRuntimePtyId(ptyId)) {
          window.api.pty.ackColdRestore(ptyId)
        }
        if (didPrepareResume && !coldRestoreStartup) {
          schedulePendingStartupCommandDelivery()
        }
      }
      // Why: when a mobile-fit override is active, skip sending desktop dims
      // to the PTY — the PTY is already at phone dimensions and must stay there.
      const reattachPtyId = transport.getPtyId()
      if (!reattachPtyId || !getFitOverrideForPty(reattachPtyId)) {
        transport.resize(cols, rows)
      }
      // Why: POSIX only delivers SIGWINCH when terminal dimensions actually
      // change. Sending it explicitly guarantees restored TUIs repaint at
      // the correct cursor position after snapshot replay.
      if (!isRemoteRuntimePtyId(ptyId)) {
        window.api.pty.signal(ptyId, 'SIGWINCH')
      }
      scheduleReattachIdleAgentCursorReset()

      scheduleRuntimeGraphSync()
    }

    // Why: if this tab has a deferred SSH session ID, trigger the SSH
    // connection now that the user has focused the tab. We check per-tab
    // (not per-target) because multiple tabs for the same target each need
    // to reattach independently. This must run before session ID resolution
    // because the SSH provider isn't registered until after connect succeeds.
    if (connectionId) {
      const storeState = useAppStore.getState()
      const restoredLeafSessionId =
        deps.restoredLeafId && deps.restoredPtyIdByLeafId
          ? (deps.restoredPtyIdByLeafId[deps.restoredLeafId] ?? null)
          : null
      const pendingSessionId =
        restoredLeafSessionId ?? storeState.deferredSshSessionIdsByTabId[deps.tabId]
      const isDeferredTarget = storeState.deferredSshReconnectTargets.includes(connectionId)
      console.warn(
        `[pty-connection] SSH tab=${deps.tabId} connectionId=${connectionId} pendingSessionId=${pendingSessionId} isDeferredTarget=${isDeferredTarget}`
      )
      if (pendingSessionId || isDeferredTarget) {
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
              callbacks: {
                onData: dataCallback,
                onReplayData: replayDataCallback,
                onError: (message) => {
                  if (isSshSessionExpiredError(message)) {
                    expiredReattachError = true
                    return
                  }
                  reportError(message)
                }
              }
            })
            void Promise.resolve(reattachPromise)
              .then(async (result) => {
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
                  const gen = await preSignalPromise
                  if (typeof gen === 'number') {
                    void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
                  }
                  if (disposed) {
                    return
                  }
                  deps.syncPanePtyLayoutBinding(pane.id, null)
                  deps.clearTabPtyId(deps.tabId, pendingSessionId)
                  startFreshColdRestoreAgentResume(coldRestoreStartup)
                  return
                }
                handleReattachResult(result, pendingSessionId, coldRestoreStartup)
                const gen = await preSignalPromise
                if (typeof gen === 'number') {
                  if (!isRemoteRuntimePtyId(pendingSessionId)) {
                    void window.api.pty.settlePaneSerializer(cacheKey, gen).catch(() => {})
                  }
                }
              })
              .catch(async (err) => {
                const gen = await preSignalPromise
                if (typeof gen === 'number') {
                  void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
                }
                console.warn(`[pty-connection] Reattach FAILED for tab=${deps.tabId}:`, err)
                if (disposed) {
                  return
                }
                if (isSshSessionExpiredError(err)) {
                  deps.syncPanePtyLayoutBinding(pane.id, null)
                  deps.clearTabPtyId(deps.tabId, pendingSessionId)
                  startFreshColdRestoreAgentResume(coldRestoreStartup)
                  return
                }
                startFreshColdRestoreAgentResume(coldRestoreStartup)
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

    const restoredSessionId = restoredPtyId ?? null
    const sleptRemoteRuntimeSessionId =
      restoredSessionId && isRemoteRuntimePtyId(restoredSessionId) && hasSleepingAgentSession
        ? restoredSessionId
        : null
    const detachedLivePtyId =
      existingPtyId && !hadExistingPaneTransportAtConnect && !sleptRemoteRuntimeSessionId
        ? restoredSessionId
          ? restoredSessionId === existingPtyId
            ? restoredSessionId
            : null
          : existingPtyId
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
        callbacks: {
          onData: dataCallback,
          onReplayData: replayDataCallback,
          onError: (message) => {
            if (isSshSessionExpiredError(message)) {
              expiredReattachError = true
              return
            }
            reportError(message)
          }
        }
      })

      void Promise.resolve(reattachPromise)
        .then(async (result) => {
          if (!result && expiredReattachError) {
            const gen = await preSignalPromise
            if (typeof gen === 'number') {
              void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
            }
            if (disposed) {
              return
            }
            deps.syncPanePtyLayoutBinding(pane.id, null)
            deps.clearTabPtyId(deps.tabId, deferredReattachSessionId)
            startFreshColdRestoreAgentResume(coldRestoreStartup)
            return
          }
          handleReattachResult(result, deferredReattachSessionId, coldRestoreStartup)
          const gen = await preSignalPromise
          if (typeof gen === 'number') {
            if (!isRemoteRuntimePtyId(deferredReattachSessionId)) {
              void window.api.pty.settlePaneSerializer(cacheKey, gen).catch(() => {})
            }
          }
        })
        .catch(async (err) => {
          const gen = await preSignalPromise
          if (typeof gen === 'number') {
            void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
          }
          const message = err instanceof Error ? err.message : String(err)
          warnTerminalLifecycleAnomaly('restored PTY reattach threw', {
            tabId: deps.tabId,
            worktreeId: deps.worktreeId,
            leafId: deps.restoredLeafId ?? pane.leafId,
            paneId: pane.id,
            ptyId: deferredReattachSessionId,
            reason: message
          })
          deps.syncPanePtyLayoutBinding(pane.id, null)
          deps.clearTabPtyId(deps.tabId, deferredReattachSessionId)
          if (connectionId && isSshSessionExpiredError(err)) {
            startFreshColdRestoreAgentResume(coldRestoreStartup)
            return
          }
          reportError(message)
          startFreshColdRestoreAgentResume(coldRestoreStartup)
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
        transport.attach({
          existingPtyId: attachPtyId,
          cols,
          rows,
          callbacks: {
            onData: dataCallback,
            onReplayData: replayDataCallback,
            onError: reportError
          }
        })
        deps.syncPanePtyLayoutBinding(pane.id, attachPtyId)
        deps.updateTabPtyId(deps.tabId, attachPtyId)
        agentCompletionCoordinator.startProcessTracking()
        if (attachPtyId === eagerLivePtyId) {
          registerPaneSerializerFor(attachPtyId)
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
              startFreshSpawn()
              return
            }
            // Why: this attach path reuses a PTY spawned by an earlier mount.
            // Persist the binding here so tab-level PTY ownership stays correct
            // even if no later spawn event or layout snapshot runs.
            deps.syncPanePtyLayoutBinding(pane.id, spawnedPtyId)
            deps.updateTabPtyId(deps.tabId, spawnedPtyId)
            clearPaneMode2031State()
            clearHiddenOutputRestoreState()
            transport.attach({
              existingPtyId: spawnedPtyId,
              cols,
              rows,
              callbacks: {
                onData: dataCallback,
                onReplayData: replayDataCallback,
                onError: reportError
              }
            })
            // Why: attach sets the transport's PTY id; starting process
            // tracking before this point no-ops because getPtyId() is empty.
            agentCompletionCoordinator.startProcessTracking()
          })
          .catch((err) => {
            reportError(err instanceof Error ? err.message : String(err))
          })
      } else {
        recordPtyConnectDiagnostic(`pane=${pane.id} -> FRESH SPAWN`)
        startFreshColdRestoreAgentResume(sleptRemoteColdRestoreStartup)
      }
    }
    scheduleRuntimeGraphSync()
  })

  return {
    syncProcessTracking() {
      agentCompletionCoordinator.startProcessTracking()
    },
    dispose() {
      disposed = true
      if (terminalKeyTargetSupportsEvents) {
        terminalKeyTarget.removeEventListener('keydown', onTerminalKeyDown, { capture: true })
      }
      clearPendingTerminalInputIntent()
      pendingTerminalInputWrite = null
      interruptInference.dispose()
      clearTitleOnlyInterruptTimer()
      clearCommandCodeOutputDoneTimer()
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
      clearPendingAgentTaskCompleteNotification()
      pendingTerminalBellNotification = false
      clearTerminalBellNotificationTimer()
      clearReattachIdleAgentCursorResetTimer()
      cleanupHiddenOutputRestoreDeferredRetry()
      unregisterBacklogRecovery?.()
      unregisterBacklogRecovery = null
      unregisterDocumentVisibilityRecovery?.()
      unregisterDocumentVisibilityRecovery = null
      clearPanePtyFitBinding()
      discardTerminalOutput(pane.terminal)
      unregisterE2ePtyDataInjection()
      if (agentTaskCompleteSettingsUnsubscribe !== null) {
        agentTaskCompleteSettingsUnsubscribe()
        agentTaskCompleteSettingsUnsubscribe = null
      }
      if (connectFrame !== null) {
        // Why: StrictMode and split-group remounts can dispose a pane binding
        // before its deferred PTY attach/spawn work runs. Cancel that queued
        // frame so stale bindings cannot reattach the PTY and steal the live
        // handler wiring from the current pane.
        cancelAnimationFrame(connectFrame)
        connectFrame = null
      }
      onDataDisposable.dispose()
      terminalCapabilityRepliesDisposable.dispose()
      onResizeDisposable.dispose()
      pane.container.removeEventListener(PANE_PTY_RESIZE_HOLD_FLUSH_EVENT, onHeldPtyResizeFlush)
      geometryReportObserver?.disconnect()
      if (pendingGeometryReportRaf !== null) {
        cancelAnimationFrame(pendingGeometryReportRaf)
        pendingGeometryReportRaf = null
      }
      commandLifecycle.dispose()
      agentCompletionCoordinator.dispose()
    }
  }
}
