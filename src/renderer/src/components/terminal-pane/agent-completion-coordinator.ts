/* oxlint-disable max-lines */
import { detectAgentStatusFromTitle, type AgentStatus } from '../../../../shared/agent-detection'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import {
  isRecognizedAgentType,
  recognizeAgentProcess,
  type RecognizedAgentProcess
} from '../../../../shared/agent-process-recognition'
import {
  enqueueAgentProcessInspection,
  type InspectionPriority
} from './agent-process-inspection-queue'
import type {
  AgentCompletionCoordinator,
  AgentCompletionCoordinatorOptions,
  AgentCompletionStatusSnapshot
} from './agent-completion-coordinator-types'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { isPiCompatibleAgentType } from '../../../../shared/pi-agent-kind'
import {
  titleHasExplicitAgentIdentity,
  titleIsInconclusiveNativeDroidTitle
} from './title-agent-identity'

type CompletionSource = 'hook' | 'title' | 'process-exit'
type CompletionIdentitySource = 'hook' | 'title' | 'process-exit'

type PollCadenceTier = 'active' | 'idle' | 'hidden' | 'no-evidence'

type LastCompletionIdentity = {
  source: CompletionIdentitySource
  identity: string
  agentIdentity: string | null
}

// Why: worktree switches can remount a pane while the underlying PTY and hook
// stream stay live, so stale completion replays must outlive one coordinator.
const lastCompletionIdentityByPaneKey = new Map<string, LastCompletionIdentity>()

const IDLE_POLL_INTERVAL_MS = 2_000
const ACTIVE_POLL_INTERVAL_MS = 750
// Why: a hidden pane only keeps the process-exit backstop alive — hook and title
// completion signals are push-driven and fire regardless of poll cadence or
// visibility — so it polls the OS process table far less often to cut idle CPU on
// shared SSH relays. Follow-up to #6288 / PR #6667, which deduped scans within a
// tick; this throttles the number of ticks. Visible panes keep full cadence.
const HIDDEN_POLL_INTERVAL_MS = 3_000
// Why: on hosts where one inspection is a whole-process-table scan (local
// Windows forks a powershell.exe CIM query, ~10-40x heavier than POSIX `ps`),
// a visible idle shell with no agent evidence must not pay that every 2s
// forever. It relaxes to this cadence; output/title/hook activity re-arms the
// hot cadence (see NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS), so agent starts are
// detected event-driven rather than by burning idle scans.
const NO_EVIDENCE_POLL_INTERVAL_MS = 15_000
// Why: pane activity (PTY output, title change, hook) means an agent may be
// starting; poll at the full idle cadence this long after the last activity so
// agent-start detection stays prompt without keeping idle panes hot.
const NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS = 10_000
const INSPECTION_TIMEOUT_MS = 15_000
const PENDING_TITLE_TTL_MS = Math.max(2_000, INSPECTION_TIMEOUT_MS + 500)
const PENDING_TITLE_MAX_TTL_MS = Math.max(30_000, PENDING_TITLE_TTL_MS)
const COMPLETION_REPLAY_GUARD_MS = 1_000
const HOOK_DONE_QUIET_MS = 1_500

const POLL_TIER_INTERVAL_MS: Record<PollCadenceTier, number> = {
  active: ACTIVE_POLL_INTERVAL_MS,
  idle: IDLE_POLL_INTERVAL_MS,
  hidden: HIDDEN_POLL_INTERVAL_MS,
  'no-evidence': NO_EVIDENCE_POLL_INTERVAL_MS
}

function isCompletionHookState(state: ParsedAgentStatusPayload['state']): boolean {
  // Why: only a genuine 'done' ends a turn. 'waiting'/'blocked' are handled by
  // isAttentionHookState below.
  return state === 'done'
}

function isAttentionHookState(state: ParsedAgentStatusPayload['state']): boolean {
  // Why: 'waiting' (e.g. a Claude PermissionRequest) and 'blocked' (e.g. a
  // Copilot elicitation dialog) pause mid-turn — the agent is still alive and
  // has not completed, so they must not fire agent-task-complete. The "needs
  // you" notification for these states is raised separately (smart-attention).
  return state === 'waiting' || state === 'blocked'
}

export function createAgentCompletionCoordinator(
  options: AgentCompletionCoordinatorOptions
): AgentCompletionCoordinator {
  let disposed = false
  let agentIdentityEstablished = false
  let hasAgentRunEvidence = false
  let workingStatusObserved = false
  let lastTitleStatus: AgentStatus | null = null
  let currentTurn = 0
  let processSession = 0
  let lastCompletionToken: string | null = null
  let lastCompletionAt = 0
  let lastCompletedTurn: number | null = null
  let lastCompletionSource: CompletionSource | null = null
  let lastCompletionIdentity: LastCompletionIdentity | null = null
  let lastAttentionToken: string | null = null
  let lastForegroundAgent: RecognizedAgentProcess | null = null
  let requiresFreshWorking = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pendingTitleTimer: ReturnType<typeof setTimeout> | null = null
  let pendingHookDoneTimer: ReturnType<typeof setTimeout> | null = null
  let pendingHookDoneTitle: string | null = null
  let pendingHookDonePayload: AgentCompletionStatusSnapshot | null = null
  let pendingProcessExitAgent: RecognizedAgentProcess | null = null
  let pendingTitleSequence = 0
  let pendingTitle: {
    id: number
    title: string
    expiresAt: number
    maxExpiresAt: number
    firstInspectionFinished: boolean
    validatedByFreshInspection: boolean
  } | null = null
  let inspectionInFlight = false
  let inspectionGeneration = 0
  let consecutiveInspectionErrors = 0
  // Why: output/title activity can arrive before async PTY bind; it should
  // only re-arm cadence after the bind path starts process tracking.
  let pollTrackingStarted = false
  // Why: tracks which cadence tier the armed poll timer was scheduled at, so a
  // tier change toward a faster cadence (hidden→visible flip, no-evidence pane
  // gaining activity or evidence) re-arms promptly instead of waiting out the
  // long delay (scheduleNextPoll otherwise no-ops while a timer is pending).
  let pollTimerTier: PollCadenceTier | null = null
  let lastPaneActivityAt = 0

  function clearPollTimer(): void {
    if (pollTimer === null) {
      return
    }
    clearTimeout(pollTimer)
    pollTimer = null
    pollTimerTier = null
  }

  function clearPendingTitleTimer(): void {
    if (pendingTitleTimer === null) {
      return
    }
    clearTimeout(pendingTitleTimer)
    pendingTitleTimer = null
  }

  function clearPendingHookDone(): void {
    if (pendingHookDoneTimer !== null) {
      clearTimeout(pendingHookDoneTimer)
      pendingHookDoneTimer = null
    }
    pendingHookDoneTitle = null
    pendingHookDonePayload = null
  }

  function establishAgentEvidence(): void {
    agentIdentityEstablished = true
    hasAgentRunEvidence = true
    scheduleNextPoll()
  }

  function clearAgentRunEvidence(): void {
    agentIdentityEstablished = false
    hasAgentRunEvidence = false
    workingStatusObserved = false
    pendingProcessExitAgent = null
    dropPendingTitle()
  }

  function completionToken(source: CompletionSource): string {
    if (workingStatusObserved) {
      return `turn:${currentTurn}`
    }
    if (lastForegroundAgent) {
      return `process:${processSession}`
    }
    return `${source}:${currentTurn}:${processSession}`
  }

  function hookCompletionIdentity(payload: AgentCompletionStatusSnapshot): string | null {
    if (typeof payload.stateStartedAt !== 'number' || !Number.isFinite(payload.stateStartedAt)) {
      return null
    }
    return [
      payload.state,
      payload.agentType ?? '',
      String(Math.trunc(payload.stateStartedAt))
    ].join(':')
  }

  function hookCompletionAgentIdentity(payload: AgentCompletionStatusSnapshot): string | null {
    return payload.agentType?.trim().toLowerCase() || null
  }

  function doneShouldUseQuietWindow(payload: AgentCompletionStatusSnapshot): boolean {
    // Why: Pi/OMP emit milestone 'done' while still working, so route their done
    // through the quiet window (like a resumed turn) so later work can cancel it.
    return workingStatusObserved || isPiCompatibleAgentType(hookCompletionAgentIdentity(payload))
  }

  function hookAttentionToken(payload: AgentCompletionStatusSnapshot): string {
    const identity = hookCompletionIdentity(payload)
    if (identity) {
      return `identity:${identity}`
    }
    return [
      'turn',
      String(currentTurn),
      payload.state,
      payload.agentType ?? '',
      payload.toolName ?? '',
      payload.toolInput ?? '',
      payload.prompt
    ].join(':')
  }

  function titleCompletionIdentity(title: string): string {
    return title
  }

  function titleCompletionAgentIdentity(title: string): string | null {
    const normalized = title.toLowerCase()
    if (/\bcodex\b/.test(normalized)) {
      return 'codex'
    }
    if (/\bclaude\b/.test(normalized)) {
      return 'claude'
    }
    if (/\bgemini\b/.test(normalized)) {
      return 'gemini'
    }
    if (/\bcursor(?: agent)?\b/.test(normalized)) {
      return 'cursor'
    }
    if (/\bopencode\b/.test(normalized)) {
      return 'opencode'
    }
    if (/\bdroid\b/.test(normalized)) {
      return 'droid'
    }
    if (/\bhermes\b/.test(normalized)) {
      return 'hermes'
    }
    if (/\baider\b/.test(normalized)) {
      return 'aider'
    }
    if (/\bpi\b/.test(normalized) || normalized.includes('\u03c0')) {
      return 'pi'
    }
    return null
  }

  function completionIdentityAlreadyNotified(
    completionIdentity: LastCompletionIdentity | null | undefined
  ): boolean {
    if (!completionIdentity) {
      return false
    }
    const previous = lastCompletionIdentityByPaneKey.get(options.paneKey)
    if (!previous) {
      return false
    }
    if (previous.source === completionIdentity.source) {
      return previous.identity === completionIdentity.identity
    }
    return (
      previous.agentIdentity !== null &&
      completionIdentity.agentIdentity !== null &&
      previous.agentIdentity === completionIdentity.agentIdentity
    )
  }

  function dispatchCompletion(
    source: CompletionSource,
    title: string,
    optionsOverride: {
      quietedHookDone?: boolean
      terminalIdleConfirmed?: boolean
      agentStatus?: AgentCompletionStatusSnapshot
      completionIdentity?: LastCompletionIdentity | null
    } = {}
  ): void {
    if (source !== 'hook' && pendingHookDoneTimer !== null) {
      return
    }
    if (requiresFreshWorking || lastCompletedTurn === currentTurn) {
      return
    }
    if (!options.isLive() || !hasAgentRunEvidence) {
      return
    }
    const now = Date.now()
    const token = completionToken(source)
    if (token === lastCompletionToken && now - lastCompletionAt < COMPLETION_REPLAY_GUARD_MS) {
      return
    }
    if (completionIdentityAlreadyNotified(optionsOverride.completionIdentity)) {
      return
    }
    lastCompletionToken = token
    lastCompletionAt = now
    lastCompletedTurn = currentTurn
    lastCompletionSource = source
    workingStatusObserved = false
    if (optionsOverride.completionIdentity) {
      lastCompletionIdentityByPaneKey.set(options.paneKey, optionsOverride.completionIdentity)
    }
    if (source === 'hook' && optionsOverride.agentStatus) {
      options.dispatchHookLifecycle?.(optionsOverride.agentStatus)
    }
    if (optionsOverride.quietedHookDone === true || source === 'process-exit') {
      // Why: confirmed process death is independent completion evidence; keep
      // its provenance so stale hook rows cannot veto the notification later.
      options.dispatchCompletion(title, {
        source,
        quietedHookDone: optionsOverride.quietedHookDone === true,
        ...(optionsOverride.terminalIdleConfirmed === true ? { terminalIdleConfirmed: true } : {}),
        ...(optionsOverride.agentStatus ? { agentStatus: optionsOverride.agentStatus } : {})
      })
    } else {
      options.dispatchCompletion(title)
    }
  }

  function dispatchAttention(payload: AgentCompletionStatusSnapshot): void {
    if (!options.dispatchAttention || !options.isLive() || !hasAgentRunEvidence) {
      return
    }
    const token = hookAttentionToken(payload)
    if (token === lastAttentionToken) {
      return
    }
    lastAttentionToken = token
    options.dispatchHookLifecycle?.(payload)
    options.dispatchAttention(payload.agentType ?? options.paneKey, {
      source: 'hook',
      agentStatus: payload
    })
  }

  function scheduleHookDoneCompletion(title: string, payload: AgentCompletionStatusSnapshot): void {
    pendingHookDoneTitle = title
    pendingHookDonePayload = payload
    if (pendingHookDoneTimer !== null) {
      return
    }
    // Why: goal/mission agents can report a temporary done state between
    // milestones. Wait for a short quiet window so resumed work can cancel it.
    pendingHookDoneTimer = setTimeout(() => {
      pendingHookDoneTimer = null
      const pendingTitle = pendingHookDoneTitle
      const pendingPayload = pendingHookDonePayload
      pendingHookDoneTitle = null
      pendingHookDonePayload = null
      if (pendingTitle) {
        const hookIdentity = pendingPayload ? hookCompletionIdentity(pendingPayload) : null
        dispatchCompletion('hook', pendingTitle, {
          quietedHookDone: true,
          ...(pendingPayload ? { agentStatus: pendingPayload } : {}),
          ...(hookIdentity
            ? {
                completionIdentity: {
                  source: 'hook',
                  identity: hookIdentity,
                  agentIdentity: pendingPayload ? hookCompletionAgentIdentity(pendingPayload) : null
                }
              }
            : {})
        })
      }
    }, HOOK_DONE_QUIET_MS)
  }

  function dropPendingTitle(): void {
    clearPendingTitleTimer()
    pendingTitle = null
  }

  function dispatchPendingTitleIfEligible(): void {
    if (
      !pendingTitle ||
      !pendingTitle.validatedByFreshInspection ||
      !agentIdentityEstablished ||
      !hasAgentRunEvidence
    ) {
      return
    }
    const title = pendingTitle.title
    dropPendingTitle()
    markTitleCompletionNotified(title)
    dispatchCompletion('title', title, {
      completionIdentity: {
        source: 'title',
        identity: titleCompletionIdentity(title),
        agentIdentity: titleCompletionAgentIdentity(title)
      }
    })
  }

  function schedulePendingTitleExpiry(): void {
    clearPendingTitleTimer()
    const pending = pendingTitle
    if (!pending) {
      return
    }
    const remaining = pending.expiresAt - Date.now()
    if (remaining <= 0) {
      pendingTitle = null
      scheduleNextPoll()
      return
    }
    pendingTitleTimer = setTimeout(() => {
      pendingTitleTimer = null
      if (!pendingTitle) {
        return
      }
      if (!pendingTitle.firstInspectionFinished && Date.now() < pendingTitle.maxExpiresAt) {
        pendingTitle.expiresAt = Math.min(Date.now() + 500, pendingTitle.maxExpiresAt)
        schedulePendingTitleExpiry()
        return
      }
      pendingTitle = null
      scheduleNextPoll()
    }, remaining)
  }

  function holdTitleCompletionPending(title: string): void {
    const now = Date.now()
    // Why: generic spinner titles can be just "⠋ cwd"; hold the completion
    // only long enough for one foreground-process probe to prove an agent owns it.
    pendingTitle = {
      id: ++pendingTitleSequence,
      title,
      expiresAt: Math.min(now + PENDING_TITLE_TTL_MS, now + PENDING_TITLE_MAX_TTL_MS),
      maxExpiresAt: now + PENDING_TITLE_MAX_TTL_MS,
      firstInspectionFinished: false,
      validatedByFreshInspection: false
    }
    schedulePendingTitleExpiry()
    requestInspection('pending-title')
  }

  function handleRecognizedProcess(process: RecognizedAgentProcess): void {
    pendingProcessExitAgent = null
    if (lastForegroundAgent?.agent !== process.agent) {
      if (lastForegroundAgent && hasAgentRunEvidence) {
        if (
          options.shouldSuppressProcessReplacementCompletion?.(lastForegroundAgent, process) !==
          true
        ) {
          dispatchCompletion('process-exit', lastForegroundAgent.processName, {
            completionIdentity: {
              source: 'process-exit',
              identity: `${lastForegroundAgent.agent}:${lastForegroundAgent.processName}`,
              agentIdentity: lastForegroundAgent.agent
            }
          })
        }
      }
      processSession += 1
    }
    lastForegroundAgent = process
    establishAgentEvidence()
  }

  function handleProcessInspectionResult(result: RuntimeTerminalProcessInspection): boolean {
    consecutiveInspectionErrors = 0
    const recognized = recognizeAgentProcess(result.foregroundProcess)
    if (recognized) {
      handleRecognizedProcess(recognized)
      return true
    }
    if (pendingHookDoneTimer !== null) {
      // Why: a pending quiet-window 'done' is the authoritative completion;
      // tearing down agent evidence here would make the timer drop it.
      scheduleNextPoll()
      return false
    }
    if (lastForegroundAgent && hasAgentRunEvidence) {
      if (result.hasChildProcesses) {
        // Why: Codex can briefly report a shell/null foreground while its TUI or
        // child work is still alive; do not announce completion from that blip.
        pendingProcessExitAgent = null
        scheduleNextPoll()
        return false
      }
      if (
        !pendingProcessExitAgent ||
        pendingProcessExitAgent.agent !== lastForegroundAgent.agent ||
        pendingProcessExitAgent.processName !== lastForegroundAgent.processName
      ) {
        // Why: macOS process inspection can transiently report no foreground
        // child during prompt handoff; require the idle sample to repeat.
        pendingProcessExitAgent = lastForegroundAgent
        scheduleNextPoll()
        return false
      }
      const exited = lastForegroundAgent
      pendingProcessExitAgent = null
      if (options.shouldSuppressConfirmedProcessExitCompletion?.(exited) !== true) {
        dispatchCompletion('process-exit', exited.processName, {
          terminalIdleConfirmed: true,
          completionIdentity: {
            source: 'process-exit',
            identity: `${exited.agent}:${exited.processName}`,
            agentIdentity: exited.agent
          }
        })
      }
      lastForegroundAgent = null
      clearAgentRunEvidence()
    } else {
      lastForegroundAgent = null
      clearAgentRunEvidence()
    }
    return false
  }

  function requestInspection(priority: InspectionPriority): void {
    if (disposed || inspectionInFlight || !options.isLive()) {
      return
    }
    if (priority === 'cadence' && !shouldRunCadenceInspection()) {
      return
    }
    const ptyId = options.getPtyId()
    if (!ptyId) {
      return
    }
    inspectionInFlight = true
    const generationAtRequest = inspectionGeneration
    const pendingTitleIdAtRequest = priority === 'pending-title' ? pendingTitle?.id : null
    enqueueAgentProcessInspection({
      priority,
      run: async () => {
        let inspectedRecognizedAgent = false
        let inspectionSucceeded = false
        try {
          const result = await options.inspectProcess(options.getSettings(), ptyId)
          if (!disposed && generationAtRequest === inspectionGeneration) {
            const appliesToCurrentPendingTitle =
              !pendingTitle ||
              (priority === 'pending-title' && pendingTitle.id === pendingTitleIdAtRequest)
            if (appliesToCurrentPendingTitle) {
              inspectedRecognizedAgent = handleProcessInspectionResult(result)
            }
            inspectionSucceeded = true
          }
        } catch {
          consecutiveInspectionErrors += 1
        } finally {
          inspectionInFlight = false
          if (generationAtRequest !== inspectionGeneration) {
            if (pendingTitle) {
              requestInspection('pending-title')
            } else {
              scheduleNextPoll()
            }
          } else {
            if (pendingTitle) {
              if (priority === 'pending-title' && pendingTitle.id === pendingTitleIdAtRequest) {
                pendingTitle.firstInspectionFinished = true
                if (inspectionSucceeded && inspectedRecognizedAgent) {
                  pendingTitle.validatedByFreshInspection = true
                  dispatchPendingTitleIfEligible()
                } else if (!inspectionSucceeded) {
                  dropPendingTitle()
                }
                schedulePendingTitleExpiry()
              } else {
                // Why: only the probe requested for this exact pending title
                // can prove it belongs to an agent; older in-flight probes are
                // stale even when they were also pending-title inspections.
                requestInspection('pending-title')
              }
            }
            scheduleNextPoll()
          }
        }
      }
    })
  }

  function shouldRunCadenceInspection(): boolean {
    // Why: hidden idle terminals should not join the global process-inspection
    // cadence. Once a pane has agent evidence, keep the backstop alive so an
    // unannounced process exit can still produce/clear completion state.
    return (
      hasAgentRunEvidence ||
      lastForegroundAgent !== null ||
      options.shouldPollProcessCadence?.() !== false
    )
  }

  function isHiddenBackstop(): boolean {
    // Why: cadence runs as a hidden-pane backstop only when visibility is known
    // to be false. An undefined option (coordinators with no visibility source)
    // keeps full cadence, matching pre-throttle behavior.
    return options.shouldPollProcessCadence?.() === false
  }

  function paneActivityWithinHotWindow(): boolean {
    return (
      lastPaneActivityAt > 0 && Date.now() - lastPaneActivityAt < NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS
    )
  }

  function currentPollTier(): PollCadenceTier {
    if (isHiddenBackstop()) {
      return 'hidden'
    }
    if (lastForegroundAgent) {
      return 'active'
    }
    if (hasAgentRunEvidence) {
      return 'idle'
    }
    // Why: only costly hosts relax the no-evidence cadence; recent pane
    // activity keeps it hot so an agent start is inspected promptly.
    if (options.isProcessInspectionCostly?.() === true && !paneActivityWithinHotWindow()) {
      return 'no-evidence'
    }
    return 'idle'
  }

  function nextPollInterval(tier: PollCadenceTier): number {
    // Why: a hidden pane polls slowly (backstop only); a visible pane keeps full
    // cadence so the foreground experience is unchanged.
    const base = POLL_TIER_INTERVAL_MS[tier]
    const backoff =
      consecutiveInspectionErrors > 0
        ? // Why: max(base, ...) keeps error backoff from *accelerating* tiers
          // already slower than the 10s backoff ceiling (no-evidence is 15s).
          Math.min(Math.max(10_000, base), base * 2 ** consecutiveInspectionErrors)
        : base
    const jitter = 1 + (Math.random() * 0.2 - 0.1)
    return Math.round(backoff * jitter)
  }

  function scheduleNextPoll(): void {
    if (disposed || !pollTrackingStarted || !options.isLive() || pendingTitle) {
      return
    }
    const tier = currentPollTier()
    if (pollTimer !== null) {
      // Why: a pane whose tier moved to a faster cadence (hidden pane became
      // visible, no-evidence pane saw activity or evidence) has a slow timer
      // armed; re-arm at the faster cadence now instead of waiting it out.
      if (
        pollTimerTier !== null &&
        POLL_TIER_INTERVAL_MS[tier] < POLL_TIER_INTERVAL_MS[pollTimerTier]
      ) {
        clearPollTimer()
      } else {
        return
      }
    }
    if (!shouldRunCadenceInspection()) {
      return
    }
    const ptyId = options.getPtyId()
    if (!ptyId) {
      return
    }
    pollTimerTier = tier
    pollTimer = setTimeout(() => {
      pollTimer = null
      pollTimerTier = null
      requestInspection('cadence')
    }, nextPollInterval(tier))
  }

  function recordPaneActivity(): void {
    lastPaneActivityAt = Date.now()
    // Why: activity is the escalation signal that ends the relaxed no-evidence
    // cadence — re-arm only when the armed timer is the slow tier (or none is
    // armed) so per-output-chunk calls stay near-free on hot panes.
    if (pollTimer === null || pollTimerTier === 'no-evidence') {
      scheduleNextPoll()
    }
  }

  function observeOutputActivity(): void {
    recordPaneActivity()
  }

  function recordTitleWorking(): boolean {
    // Why: hooks can report `done` before title tracking notices the next
    // milestone. The title working signal must cancel that provisional done.
    clearPendingHookDone()
    if (
      lastCompletionSource === 'hook' &&
      Date.now() - lastCompletionAt < COMPLETION_REPLAY_GUARD_MS
    ) {
      return false
    }
    workingStatusObserved = true
    requiresFreshWorking = false
    lastCompletionIdentityByPaneKey.delete(options.paneKey)
    currentTurn += 1
    dropPendingTitle()
    return true
  }

  function observeTitleWorking(): void {
    recordTitleWorking()
  }

  function observeTitle(title: string): void {
    recordPaneActivity()
    const status = detectAgentStatusFromTitle(title)
    const isInconclusiveNativeDroidTitle = titleIsInconclusiveNativeDroidTitle(title)
    const hasExplicitAgentIdentity =
      titleHasExplicitAgentIdentity(title) && !isInconclusiveNativeDroidTitle
    const hadPendingTitle = pendingTitle !== null
    if (hasExplicitAgentIdentity) {
      establishAgentEvidence()
    }

    if (status === 'working') {
      if (!recordTitleWorking()) {
        return
      }
    } else if (lastTitleStatus === 'working') {
      if (isInconclusiveNativeDroidTitle) {
        lastTitleStatus = status
        return
      }
      if (status === null && !titleHasExplicitAgentIdentity(title)) {
        // Why: shells commonly restore cwd titles right after a short printf
        // command. Treat generic completion titles as provisional until process
        // inspection proves an agent still owns the pane.
        holdTitleCompletionPending(title)
        lastTitleStatus = status
        return
      }
      if (agentIdentityEstablished && hasAgentRunEvidence) {
        markTitleCompletionNotified(title)
        dispatchCompletion('title', title, {
          completionIdentity: {
            source: 'title',
            identity: titleCompletionIdentity(title),
            agentIdentity: titleCompletionAgentIdentity(title)
          }
        })
      } else {
        holdTitleCompletionPending(title)
      }
    } else if (hadPendingTitle && status !== null && hasExplicitAgentIdentity) {
      // Why: a shell can briefly restore cwd between "Codex working" and
      // "Codex done"; the later explicit agent completion is authoritative.
      dropPendingTitle()
      markTitleCompletionNotified(title)
      dispatchCompletion('title', title, {
        completionIdentity: {
          source: 'title',
          identity: titleCompletionIdentity(title),
          agentIdentity: titleCompletionAgentIdentity(title)
        }
      })
    }
    lastTitleStatus = status
  }

  function observeClassifiedTitleCompletion(title: string): void {
    if (titleHasExplicitAgentIdentity(title)) {
      establishAgentEvidence()
    }
    if (agentIdentityEstablished && hasAgentRunEvidence) {
      markTitleCompletionNotified(title)
      dispatchCompletion('title', title, {
        completionIdentity: {
          source: 'title',
          identity: titleCompletionIdentity(title),
          agentIdentity: titleCompletionAgentIdentity(title)
        }
      })
    } else {
      holdTitleCompletionPending(title)
    }
  }

  function observeHookStatus(payload: AgentCompletionStatusSnapshot): void {
    recordPaneActivity()
    if (options.shouldSuppressHookCompletion?.(payload)) {
      // Why: a suppressed permission pause must still cancel a provisional 'done'
      // so the quiet-window timer never fires a false completion notification.
      if (isAttentionHookState(payload.state)) {
        clearPendingHookDone()
      }
      return
    }
    if (isRecognizedAgentType(payload.agentType)) {
      establishAgentEvidence()
    }
    if (payload.state === 'working') {
      clearPendingHookDone()
      workingStatusObserved = true
      requiresFreshWorking = false
      lastCompletionIdentity = null
      lastAttentionToken = null
      currentTurn += 1
      dropPendingTitle()
      options.dispatchHookLifecycle?.(payload)
      return
    }
    if (isAttentionHookState(payload.state)) {
      // Why: a permission/elicitation pause arriving before the quiet window
      // must cancel a provisional 'done' so it never becomes a false completion.
      clearPendingHookDone()
      dispatchAttention(payload)
      return
    }
    if (isCompletionHookState(payload.state)) {
      if (isRecognizedAgentType(payload.agentType)) {
        establishAgentEvidence()
      }
      const hookIdentity = hookCompletionIdentity(payload)
      if (
        hookIdentity &&
        lastCompletionIdentity?.source === 'hook' &&
        hookIdentity === lastCompletionIdentity.identity
      ) {
        // Why: activation/switching can replay the same main-process hook snapshot
        // after the 1s guard; only pending quiet-window detail should refresh.
        if (payload.state === 'done' && pendingHookDoneTimer !== null) {
          scheduleHookDoneCompletion(payload.agentType ?? options.paneKey, payload)
        }
        return
      }
      if (
        !workingStatusObserved &&
        lastCompletionSource === 'hook' &&
        lastCompletedTurn === currentTurn &&
        Date.now() - lastCompletionAt >= COMPLETION_REPLAY_GUARD_MS
      ) {
        // Why: some hook producers only emit terminal states. Treat later
        // done-only hook completions as new turns without letting title/process
        // backstops duplicate the same completion.
        currentTurn += 1
      }
      if (payload.state === 'done' && doneShouldUseQuietWindow(payload)) {
        lastCompletionIdentity = hookIdentity
          ? {
              source: 'hook',
              identity: hookIdentity,
              agentIdentity: hookCompletionAgentIdentity(payload)
            }
          : null
        scheduleHookDoneCompletion(payload.agentType ?? options.paneKey, payload)
        return
      }
      lastCompletionIdentity = hookIdentity
        ? {
            source: 'hook',
            identity: hookIdentity,
            agentIdentity: hookCompletionAgentIdentity(payload)
          }
        : null
      dispatchCompletion('hook', payload.agentType ?? options.paneKey, {
        agentStatus: payload,
        ...(lastCompletionIdentity ? { completionIdentity: lastCompletionIdentity } : {})
      })
    }
  }

  function markTitleCompletionNotified(title: string): void {
    lastCompletionIdentity = {
      source: 'title',
      identity: titleCompletionIdentity(title),
      agentIdentity: titleCompletionAgentIdentity(title)
    }
  }

  function startProcessTracking(): void {
    pollTrackingStarted = true
    scheduleNextPoll()
  }

  function hasPendingHookDoneCompletion(): boolean {
    return pendingHookDoneTimer !== null
  }

  function resetCompletionState(options: { requireFreshWorking?: boolean } = {}): void {
    clearPendingHookDone()
    dropPendingTitle()
    agentIdentityEstablished = false
    hasAgentRunEvidence = false
    workingStatusObserved = false
    lastTitleStatus = null
    lastCompletionToken = null
    lastCompletionAt = 0
    lastCompletedTurn = null
    lastCompletionSource = null
    lastCompletionIdentity = null
    lastAttentionToken = null
    lastForegroundAgent = null
    requiresFreshWorking = options.requireFreshWorking ?? false
    inspectionGeneration += 1
  }

  function dispose(): void {
    disposed = true
    clearPollTimer()
    clearPendingHookDone()
    dropPendingTitle()
    // Why: the dedup identity is module-scoped so it survives a live-stream remount
    // (dispose-then-recreate with the same paneKey while isLive() stays true). Only
    // evict it on genuine teardown — when the PTY is gone (isLive() false) — so the
    // never-reused ${tabId}:${leafUUID} key can't leak one identity per closed pane.
    if (!options.isLive()) {
      lastCompletionIdentityByPaneKey.delete(options.paneKey)
    }
  }

  return {
    observeTitle,
    observeClassifiedTitleCompletion,
    observeTitleWorking,
    observeOutputActivity,
    observeHookStatus,
    startProcessTracking,
    hasPendingHookDoneCompletion,
    resetCompletionState,
    dispose
  }
}

export function resetAgentCompletionCoordinatorIdentitiesForTest(): void {
  lastCompletionIdentityByPaneKey.clear()
}

export function getAgentCompletionCoordinatorIdentityCountForTest(): number {
  return lastCompletionIdentityByPaneKey.size
}
