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
import type { PtyConnectResult } from './pty-transport'
import { createIpcPtyTransport } from './pty-transport'
import { createRemoteRuntimePtyTransport } from './remote-runtime-pty-transport'
import { shouldSeedCacheTimerOnInitialTitle } from './cache-timer-seeding'
import type { PtyConnectionDeps } from './pty-connection-types'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty, bindPanePtyId } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { isPaneReplaying, replayIntoTerminal } from './replay-guard'
import { terminalOutputPrefersDomRenderer } from '@/lib/pane-manager/terminal-complex-script'
import {
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_TERMINAL_CURSOR_STYLE
} from './layout-serialization'
import { warnTerminalLifecycleAnomaly } from './terminal-lifecycle-diagnostics'
import { registerPtySerializer, registerPtyTitleSource } from './pty-buffer-serializer'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import {
  discardTerminalOutput,
  flushTerminalOutput,
  registerTerminalBacklogRecovery,
  suppressTerminalCursorUntilOutputSettles,
  waitForTerminalOutputParsed,
  writeTerminalOutput
} from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { isLocalNativeWindowsPty } from '@/lib/pane-manager/windows-pty-compatibility'
import { recordTerminalOutput, restoreScrollStateAfterLayout } from '@/lib/pane-manager/pane-scroll'
import type { ScrollState } from '@/lib/pane-manager/pane-manager-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
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
import {
  markTerminalBracketedPasteInterrupted,
  observeTerminalBracketedPasteModeOutput,
  pasteTerminalText
} from './terminal-bracketed-paste'
import { createCommandCodeOutputStatusDetector } from './command-code-output-status'
import type { PtyDataMeta } from './pty-dispatcher'

const pendingSpawnByPaneKey = new Map<string, Promise<string | null>>()
const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
const REMOTE_PTY_ID_PREFIX = 'remote:'
const PTY_CONNECT_DIAG_LIMIT = 200
const AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS = 250
const AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS = 1000
const AGENT_TASK_COMPLETE_NOTIFICATION_DETAIL_MAX_AGE_MS = 10_000
const COMMAND_CODE_OUTPUT_DONE_SETTLE_MS = 1500
const HIDDEN_OUTPUT_RESTORE_SCROLLBACK_ROWS = 5000
const HIDDEN_OUTPUT_RESTORE_PENDING_CHARS = 512 * 1024
// Why: this is only shown if renderer backlog overflowed and main-owned
// terminal state is unavailable, so the user has an explicit loss signal.
const HIDDEN_OUTPUT_RESTORE_UNAVAILABLE_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped hidden terminal output because the backlog exceeded 2 MB and main recovery was unavailable.]\r\n'
let codexRestartNoticePresenceSource: Record<
  string,
  { previousAccountLabel: string; nextAccountLabel: string }
> | null = null
let codexRestartNoticePresence = false

function isAgentTaskCompleteNotificationEnabled(): boolean {
  const notifications = useAppStore.getState().settings?.notifications
  return notifications?.enabled !== false && notifications?.agentTaskComplete !== false
}

function hasAgentNotificationDetail(entry: AgentStatusEntry | undefined): boolean {
  return Boolean(
    entry &&
    Date.now() - entry.updatedAt <= AGENT_TASK_COMPLETE_NOTIFICATION_DETAIL_MAX_AGE_MS &&
    (entry.lastAssistantMessage || entry.toolName || entry.toolInput)
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

export function connectPanePty(
  pane: ManagedPane,
  manager: PaneManager,
  deps: PtyConnectionDeps
): IDisposable {
  let disposed = false
  let connectFrame: number | null = null
  let unregisterBacklogRecovery: (() => void) | null = null
  let unregisterDocumentVisibilityRecovery: (() => void) | null = null
  let startupInjectTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteNotificationGraceTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteNotificationMaxTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteStatusUnsubscribe: (() => void) | null = null
  let agentTaskCompleteSettingsUnsubscribe: (() => void) | null = null
  let agentTaskCompleteNotificationGeneration = 0
  let wasAgentTaskCompleteNotificationEnabled = isAgentTaskCompleteNotificationEnabled()
  let terminalBellNotificationTimer: ReturnType<typeof setTimeout> | null = null
  let pendingTerminalBellNotification = false
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
    if (!entry) {
      return
    }
    const state = useAppStore.getState()
    const current = state.agentStatusByPaneKey[cacheKey]
    if (!current) {
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
      return
    }
    if (isCtrlCKeyEvent(event)) {
      if (!navigator.userAgent.includes('Mac') && pane.terminal.hasSelection()) {
        return
      }
      setPendingTerminalInputIntent('ctrl-c')
    }
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

  const agentCompletionCoordinator = createAgentCompletionCoordinator({
    paneKey: cacheKey,
    getPtyId: () => transport.getPtyId(),
    getSettings: () => useAppStore.getState().settings,
    inspectProcess: inspectRuntimeTerminalProcess,
    dispatchCompletion: (title) => scheduleAgentTaskCompleteNotification(title),
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
    if (syncAgentTaskCompleteNotificationEnabled()) {
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
    useAppStore.getState().setAgentStatus(
      cacheKey,
      {
        state: 'working',
        prompt: initialStatus.prompt,
        agentType: initialStatus.agent
      },
      terminalTitle
    )
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

  const onPtySpawn = (ptyId: string): void => {
    bindPanePtyId(pane.id, ptyId, deps.tabId)
    pane.container.dataset.ptyId = ptyId
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
    (agentTaskCompleteNotificationGraceTimer !== null ||
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

  const syncAgentTaskCompleteNotificationEnabled = (): boolean => {
    const enabled = isAgentTaskCompleteNotificationEnabled()
    if (!enabled && wasAgentTaskCompleteNotificationEnabled) {
      // Why: disabling notifications is an event-time boundary. Drop pending
      // timers and coordinator state so completions observed while off cannot
      // replay if the user turns the setting back on.
      agentTaskCompleteNotificationGeneration += 1
      clearPendingAgentTaskCompleteNotification()
      agentCompletionCoordinator.resetCompletionState({ requireFreshWorking: true })
      if (pendingTerminalBellNotification) {
        scheduleTerminalBellNotification()
      }
    } else if (enabled && !wasAgentTaskCompleteNotificationEnabled) {
      // Why: a pane may have observed work while agent-complete was disabled.
      // Re-enabling should not let the next idle event notify for that old task.
      agentCompletionCoordinator.resetCompletionState({ requireFreshWorking: true })
    }
    wasAgentTaskCompleteNotificationEnabled = enabled
    return enabled
  }

  const scheduleAgentTaskCompleteNotification = (title: string): void => {
    if (!syncAgentTaskCompleteNotificationEnabled()) {
      return
    }
    clearPendingAgentTaskCompleteNotification()
    let graceElapsed = false
    const generationAtSchedule = agentTaskCompleteNotificationGeneration

    const dispatch = (): void => {
      clearPendingAgentTaskCompleteNotification()
      if (
        generationAtSchedule !== agentTaskCompleteNotificationGeneration ||
        !syncAgentTaskCompleteNotificationEnabled()
      ) {
        return
      }
      pendingTerminalBellNotification = false
      clearTerminalBellNotificationTimer()
      if (disposed) {
        return
      }
      deps.dispatchNotification({
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey: cacheKey
      })
    }

    const dispatchIfDetailed = (): void => {
      if (!graceElapsed) {
        return
      }
      const entry = useAppStore.getState().agentStatusByPaneKey[cacheKey]
      if (hasAgentNotificationDetail(entry)) {
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
  agentTaskCompleteSettingsUnsubscribe = useAppStore.subscribe((state, previousState) => {
    if (state.settings?.notifications !== previousState?.settings?.notifications) {
      syncAgentTaskCompleteNotificationEnabled()
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
    if (syncAgentTaskCompleteNotificationEnabled()) {
      agentCompletionCoordinator.observeClassifiedTitleCompletion(title)
    }
    // Why: some agent TUIs leave xterm in DECSCUSR steady-cursor mode when
    // they become idle. Reset to Orca's configured cursor once the turn ends.
    queueAgentIdleCursorReset()
  }
  const onAgentBecameWorking = (): void => {
    if (syncAgentTaskCompleteNotificationEnabled()) {
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
  const paneEnv = {
    ...paneStartup?.env,
    ORCA_PANE_KEY: cacheKey,
    ORCA_TAB_ID: deps.tabId,
    ORCA_WORKTREE_ID: deps.worktreeId
  }

  // Why: remote repos route PTY spawn through the SSH provider. Resolve the
  // repo's connectionId from the store so the transport passes it to pty:spawn.
  const state = useAppStore.getState()
  const allWorktrees = Object.values(state.worktreesByRepo ?? {}).flat()
  const worktree = allWorktrees.find((w) => w.id === deps.worktreeId)
  const repo = worktree ? state.repos?.find((r) => r.id === worktree.repoId) : null
  const connectionId = repo?.connectionId ?? null
  const tab = (state.tabsByWorktree[deps.worktreeId] ?? []).find((t) => t.id === deps.tabId)
  const shellOverride = tab?.shellOverride
  const shouldSuppressForegroundCursor = isLocalNativeWindowsPty({
    userAgent: navigator.userAgent,
    connectionId,
    cwd: deps.cwd,
    shellOverride
  })

  const restoredPtyIdForTransport =
    deps.restoredLeafId && deps.restoredPtyIdByLeafId
      ? (deps.restoredPtyIdByLeafId[deps.restoredLeafId] ?? null)
      : null
  const remoteRuntimeOwnerForTransport =
    (restoredPtyIdForTransport
      ? getRemoteRuntimePtyEnvironmentId(restoredPtyIdForTransport)
      : null) ?? (tab?.ptyId ? getRemoteRuntimePtyEnvironmentId(tab.ptyId) : null)
  const activeRuntimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim() || null
  const runtimeEnvironmentId = remoteRuntimeOwnerForTransport ?? activeRuntimeEnvironmentId
  const shouldDeliverStartupViaTerminalPaste = paneStartup?.delivery === 'terminal-paste'
  const transportOptions = {
    cwd: deps.cwd,
    env: paneEnv,
    command: shouldDeliverStartupViaTerminalPaste ? undefined : paneStartup?.command,
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
    ...(paneStartup?.telemetry ? { telemetry: paneStartup.telemetry } : {}),
    onPtyExit: onExit,
    onTitleChange,
    onPtySpawn,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    // Why: forward OSC 9999 payloads from the PTY stream to the agent-status slice.
    // Without this, the OSC parser in pty-transport strips sequences from xterm
    // output but the status never reaches the store or dashboard/hover UI.
    onAgentStatus: (payload) => {
      // Why: capture the store snapshot once so the title lookup and the
      // setAgentStatus call observe the same state. Re-reading getState()
      // between the two lines opens a brief window where the title could
      // shift (OSC title update landing in between) and the status would be
      // stored against a title that was never paired with it.
      const currentState = useAppStore.getState()
      const title = currentState.runtimePaneTitlesByTabId?.[deps.tabId]?.[pane.id]
      currentState.setAgentStatus(cacheKey, payload, title)
      if (syncAgentTaskCompleteNotificationEnabled()) {
        agentCompletionCoordinator.observeHookStatus(payload)
      }
    }
  }
  const transport = runtimeEnvironmentId
    ? createRemoteRuntimePtyTransport(runtimeEnvironmentId, transportOptions)
    : createIpcPtyTransport(transportOptions)
  const hasExistingPaneTransport = deps.paneTransportsRef.current.size > 0
  deps.paneTransportsRef.current.set(pane.id, transport)

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
    // PTY, desktop keystrokes must not reach the shell — any input would
    // race the mobile session and is also dimensionally wrong (PTY is at
    // phone fit). Renderer-side guard belongs here so we don't even mark
    // the pane as "interacted" (no unread clear, no take-floor cascade).
    // The pty:write IPC has a defense-in-depth twin. See
    // docs/mobile-presence-lock.md.
    if (currentPtyId && isPtyLocked(currentPtyId)) {
      clearPendingTerminalInputIntent()
      return
    }
    // Why: a real keystroke into the terminal is the unambiguous "user is
    // here" signal that dismisses attention. Guarded by the replay and
    // codex-stale checks above so synthetic xterm auto-replies never count.
    deps.clearTerminalTabUnread(deps.tabId)
    deps.clearTerminalPaneUnread(cacheKey)
    deps.clearWorktreeUnread(deps.worktreeId)
    if (shouldSuppressForegroundCursor) {
      // Why: native Windows ConPTY can leave the old visual cursor painted
      // until the shell echoes the next frame; other PTY hosts should keep
      // normal cursor visibility when commands intentionally produce no echo.
      suppressTerminalCursorUntilOutputSettles(pane.terminal)
    }
    const intent = pendingTerminalInputIntent
    // Why: real xterm can deliver the terminal byte even when our DOM keydown
    // listener missed the press. Exact Ctrl+C/Escape bytes are still safe to
    // infer for local/remote acknowledged writes; SSH fire-and-forget remains
    // excluded because those transports do not expose sendInputAccepted.
    const acknowledgedIntent = intent ?? inferIntentFromExactTerminalInput(data)
    if (acknowledgedIntent && transport.sendInputAccepted) {
      clearPendingTerminalInputIntent()
      const writePromise = transport
        .sendInputAccepted(data)
        .then((accepted) => {
          if (accepted) {
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
        observeAcceptedTerminalInput(data, intent)
      }
      clearPendingTerminalInputIntent()
      return
    }
    if (transport.sendInput(data)) {
      observeAcceptedTerminalInput(data)
      observeSentTerminalInputIntent(data)
    } else {
      clearPendingTerminalInputIntent()
    }
  })

  const onResizeDisposable = pane.terminal.onResize(({ cols, rows }) => {
    // Why: when a mobile-fit override is active OR mobile is currently the
    // driver of this PTY, the PTY is already at phone dims and any desktop
    // resize is wrong. Suppress resize forwarding to avoid spurious SIGWINCH
    // signals (TUI flicker / wrap corruption). Both checks are needed:
    // - getFitOverrideForPty covers the "phone-fit dims" state.
    // - isPtyLocked covers the broader "mobile driving" state, including
    //   transitions where override may not be set (e.g. legacy code paths).
    // The pty:resize IPC has a defense-in-depth twin. See
    // docs/mobile-presence-lock.md.
    const currentPtyId = transport.getPtyId()
    if (currentPtyId && (getFitOverrideForPty(currentPtyId) || isPtyLocked(currentPtyId))) {
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
    if (!isRemoteRuntimePtyId(currentPtyId)) {
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
    // writes via the shell-ready barrier. terminal-paste startup commands must
    // stay renderer-delivered so xterm can apply bracketed-paste semantics.
    let pendingStartupCommand =
      shouldDeliverStartupViaTerminalPaste || connectionId ? (paneStartup?.command ?? null) : null

    const startFreshSpawn = (): void => {
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
        callbacks: {
          onData: dataCallback,
          onReplayData: replayDataCallback,
          onError: reportError
        }
      })

      const trackedPromise: Promise<string | null> = Promise.resolve(spawnedRaw)
        .then(async (spawnedPtyId) => {
          const resolvedPtyId =
            typeof spawnedPtyId === 'string' ? spawnedPtyId : transport.getPtyId()
          const gen = await preSignalPromise
          if (typeof gen === 'number' && resolvedPtyId) {
            if (!isRemoteRuntimePtyId(resolvedPtyId)) {
              registerPaneSerializerFor(resolvedPtyId)
              void window.api.pty.settlePaneSerializer(cacheKey, gen).catch(() => {})
            }
          } else if (typeof gen === 'number') {
            void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
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

    // The replay path uses the guard so xterm auto-replies to embedded query
    // sequences don't leak into the shell. xterm.write() buffers internally
    // regardless of DOM visibility and the guard stays engaged via the
    // write-completion callback until xterm finishes parsing.
    const writeReplayData = (data: string): void => {
      // Why: drain any queued background bytes BEFORE the replay paint, so the
      // scheduler's deferred drain cannot land older bytes on top of the replay.
      flushTerminalOutput(pane.terminal)
      if (terminalOutputPrefersDomRenderer(data)) {
        manager.markPaneHasComplexScriptOutput(pane.id)
      }
      replayIntoTerminal(pane, deps.replayingPanesRef, data)
    }

    const replayDataCallback = (data: string): void => {
      // Relay replay buffer holds the last 100 KB of output, which may
      // overlap with content already rendered in xterm before the
      // disconnect. Clear first to prevent duplication on SSH reconnect.
      writeReplayData('\x1b[2J\x1b[3J\x1b[H')
      writeReplayData(data)
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
    // Why: hidden recovery state belongs to one PTY stream. Reattach/restart
    // can reuse the pane object for a different session before visibility.
    let hiddenOutputRestorePtyId: string | null = null
    let hiddenOutputRestoreGeneration = 0

    function canUseMainBufferSnapshot(ptyId: string | null): ptyId is string {
      return Boolean(ptyId) && !isRemoteRuntimePtyId(ptyId)
    }

    function beforeTerminalOutputWrite(chunk: string): void {
      // Why: hidden tab output is coalesced by the scheduler. Run per-byte
      // renderer checks at the xterm write boundary so background PTY bursts
      // do not spend foreground event-loop time scanning bytes we will delay.
      if (terminalOutputPrefersDomRenderer(chunk)) {
        manager.markPaneHasComplexScriptOutput(pane.id)
      }
      recordTerminalOutput(pane.terminal)
    }

    function writePtyOutputToXterm(data: string, foreground: boolean): void {
      writeTerminalOutput(pane.terminal, data, {
        foreground,
        beforeWrite: beforeTerminalOutputWrite,
        onBackgroundBacklogDropped: markHiddenOutputRestoreNeeded
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
      if (!canUseMainBufferSnapshot(ptyId)) {
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

    function queueLiveChunkDuringRestore(data: string, meta?: PtyDataMeta): void {
      if (!data) {
        return
      }
      const ptyId = transport.getPtyId()
      if (!canUseMainBufferSnapshot(ptyId)) {
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
    }

    function clearHiddenOutputRestoreState(): void {
      clearPendingLiveChunksDuringRestore()
      hiddenOutputRestoreNeeded = false
      hiddenOutputRestorePtyId = null
      hiddenOutputRestoreGeneration += 1
    }

    function resetHiddenOutputRestoreIfPtyChanged(): void {
      if (hiddenOutputRestorePtyId === null) {
        return
      }
      if (transport.getPtyId() !== hiddenOutputRestorePtyId) {
        clearHiddenOutputRestoreState()
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
      writeReplayData(POST_REPLAY_REATTACH_RESET)
      recordTerminalOutput(pane.terminal)
      const currentPtyId = transport.getPtyId()
      if (currentPtyId && !getFitOverrideForPty(currentPtyId)) {
        safeFit(pane)
        transport.resize(pane.terminal.cols, pane.terminal.rows)
        if (!isRemoteRuntimePtyId(currentPtyId)) {
          window.api.pty.signal(currentPtyId, 'SIGWINCH')
        }
      }
      restoreScrollStateAfterSnapshotReplay(scrollState)
    }

    function requestHiddenOutputRestoreIfNeeded(): boolean {
      resetHiddenOutputRestoreIfPtyChanged()
      const ptyId = hiddenOutputRestorePtyId ?? transport.getPtyId()
      if (!hiddenOutputRestoreNeeded && hiddenOutputRestorePendingChunks.length === 0) {
        return false
      }
      if (!canUseMainBufferSnapshot(ptyId)) {
        return false
      }
      hiddenOutputRestorePtyId = ptyId
      if (hiddenOutputRestoreInFlight) {
        return true
      }

      hiddenOutputRestoreInFlight = (async () => {
        while (!disposed) {
          const currentPtyId = hiddenOutputRestorePtyId
          if (currentPtyId === null) {
            clearHiddenOutputRestoreState()
            return
          }
          if (!canUseMainBufferSnapshot(currentPtyId)) {
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
          let snapshot: { data: string; cols: number; rows: number; seq?: number } | null = null
          try {
            snapshot = await window.api.pty.getMainBufferSnapshot(currentPtyId, {
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
            clearHiddenOutputRestoreState()
            writeRestoreUnavailableWarning()
            return
          }
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
      resetHiddenOutputRestoreIfPtyChanged()
      observeTerminalBracketedPasteModeOutput(pane.terminal, data)
      commandCodeOutputStatusDetector.observe(data)
      commandLifecycle.handlePtyData(data)
      // Why: split-pane layouts have multiple visible-but-inactive panes whose
      // output the user is watching. Throttle only when the pane or whole
      // Electron document is hidden.
      const foreground = shouldWritePtyOutputForeground(deps.isVisibleRef.current)
      const restoreAppliesToCurrentPty =
        hiddenOutputRestorePtyId !== null && transport.getPtyId() === hiddenOutputRestorePtyId
      if (
        (hiddenOutputRestoreNeeded || hiddenOutputRestoreInFlight) &&
        restoreAppliesToCurrentPty
      ) {
        if (foreground) {
          queueLiveChunkDuringRestore(data, meta)
          requestHiddenOutputRestoreIfNeeded()
        } else if (hiddenOutputRestoreInFlight) {
          hiddenOutputRestoreNeeded = true
          hiddenOutputRestoreFreshSnapshotNeeded = true
        }
      } else {
        writePtyOutputToXterm(data, foreground)
      }

      if (pendingStartupCommand) {
        if (startupInjectTimer !== null) {
          clearTimeout(startupInjectTimer)
        }
        startupInjectTimer = setTimeout(() => {
          startupInjectTimer = null
          void (async () => {
            const command = pendingStartupCommand
            if (!command || disposed) {
              return
            }
            if (shouldDeliverStartupViaTerminalPaste) {
              await waitForTerminalOutputParsed(pane.terminal)
            }
            if (pendingStartupCommand !== command || disposed) {
              return
            }
            if (shouldDeliverStartupViaTerminalPaste) {
              // Why: this mode must pass through xterm so bracketed-paste
              // wrapping is applied before the submit Enter.
              pasteTerminalText(pane.terminal, command)
              transport.sendInput('\r')
            } else {
              transport.sendInput(`${command}\r`)
            }
            pendingStartupCommand = null
          })()
        }, 50)
      }
    }

    const handleReattachResult = (
      result: PtyConnectResult | string | void,
      staleSessionId?: string | null
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
        startFreshSpawn()
        return
      }
      if (connectResult?.sessionExpired) {
        deps.syncPanePtyLayoutBinding(pane.id, null)
        if (staleSessionId) {
          deps.clearTabPtyId(deps.tabId, staleSessionId)
        }
        // Why: SSH sleep/reconnect can invalidate the relay-held PTY while
        // leaving the tab mounted. Replace the dead lease in-place instead of
        // stranding the pane behind a stale expired-session overlay.
        startFreshSpawn()
        return
      }
      bindPanePtyId(pane.id, ptyId, deps.tabId)
      pane.container.dataset.ptyId = ptyId
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
        writeReplayData('\r\n\x1b[2m--- session restored ---\x1b[0m\r\n\r\n')
        // Cold-restore means the daemon lost the session and spawned a
        // fresh shell — no TUI is consuming the mode-setting bytes that a
        // crashed TUI (e.g. Claude's \e[?1004h) left in the scrollback, so
        // reset them to match the fresh shell's expectations.
        writeReplayData(POST_REPLAY_MODE_RESET)
        if (!isRemoteRuntimePtyId(ptyId)) {
          window.api.pty.ackColdRestore(ptyId)
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
            const reattachPromise = transport.connect({
              url: '',
              cols,
              rows,
              sessionId: pendingSessionId,
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
                  if (disposed) {
                    return
                  }
                  deps.syncPanePtyLayoutBinding(pane.id, null)
                  deps.clearTabPtyId(deps.tabId, pendingSessionId)
                  const gen = await preSignalPromise
                  if (typeof gen === 'number') {
                    void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
                  }
                  startFreshSpawn()
                  return
                }
                handleReattachResult(result, pendingSessionId)
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
                  startFreshSpawn()
                  return
                }
                startFreshSpawn()
              })
          } else {
            startFreshSpawn()
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

    const restoredSessionId = restoredPtyId ?? null
    const detachedLivePtyId =
      existingPtyId && !hasExistingPaneTransport
        ? restoredSessionId
          ? restoredSessionId === existingPtyId
            ? restoredSessionId
            : null
          : existingPtyId
        : null
    const detachedRemoteLeafPtyId =
      restoredSessionId && isRemoteRuntimePtyId(restoredSessionId) ? restoredSessionId : null
    const candidateReattachSessionId =
      restoredSessionId && restoredSessionId !== detachedLivePtyId
        ? restoredSessionId
        : detachedLivePtyId
    // Why: daemon session IDs encode `${worktreeId}@@${uuid}`. After a daemon
    // crash + cold restore, corrupted or stale session-to-tab mappings can
    // cause a tab in workspace A to hold a ptyId from workspace B. Restoring
    // that session would paint the wrong terminal content in this pane. Drop
    // the reattach and spawn a fresh session instead.
    const deferredReattachSessionId =
      candidateReattachSessionId &&
      !isRemoteRuntimePtyId(candidateReattachSessionId) &&
      isSessionOwnedByWorktree(candidateReattachSessionId, deps.worktreeId)
        ? candidateReattachSessionId
        : null
    recordPtyConnectDiagnostic(
      `pane=${pane.id} tab=${deps.tabId} restored=${restoredPtyId} existing=${existingPtyId} detached=${detachedRemoteLeafPtyId ?? detachedLivePtyId} reattach=${deferredReattachSessionId} hasTransport=${hasExistingPaneTransport} pendingKey=${pendingSpawnKey}`
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
      const reattachPromise = transport.connect({
        url: '',
        cols,
        rows,
        sessionId: deferredReattachSessionId,
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
            if (disposed) {
              return
            }
            deps.syncPanePtyLayoutBinding(pane.id, null)
            deps.clearTabPtyId(deps.tabId, deferredReattachSessionId)
            const gen = await preSignalPromise
            if (typeof gen === 'number') {
              void window.api.pty.clearPendingPaneSerializer(cacheKey, gen).catch(() => {})
            }
            startFreshSpawn()
            return
          }
          handleReattachResult(result, deferredReattachSessionId)
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
            startFreshSpawn()
            return
          }
          reportError(message)
          startFreshSpawn()
        })
    } else if (detachedRemoteLeafPtyId || detachedLivePtyId) {
      // Why: mirrored web terminal layouts mount one pane per host leaf.
      // Later leaves already have a pane transport, but must still attach to
      // their exact remote PTY instead of spawning replacement host tabs.
      const attachPtyId = detachedRemoteLeafPtyId ?? detachedLivePtyId!
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
        startFreshSpawn()
      }
    }
    scheduleRuntimeGraphSync()
  })

  return {
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
      clearPendingAgentTaskCompleteNotification()
      pendingTerminalBellNotification = false
      clearTerminalBellNotificationTimer()
      unregisterBacklogRecovery?.()
      unregisterBacklogRecovery = null
      unregisterDocumentVisibilityRecovery?.()
      unregisterDocumentVisibilityRecovery = null
      discardTerminalOutput(pane.terminal)
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
      onResizeDisposable.dispose()
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
