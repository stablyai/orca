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
import {
  titleHasExplicitAgentIdentity,
  titleIsInconclusiveNativeDroidTitle
} from './title-agent-identity'

type CompletionSource = 'hook' | 'title' | 'process-exit'
type CompletionIdentitySource = 'hook' | 'title' | 'process-exit'

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
const INSPECTION_TIMEOUT_MS = 15_000
const PENDING_TITLE_TTL_MS = Math.max(2_000, INSPECTION_TIMEOUT_MS + 500)
const PENDING_TITLE_MAX_TTL_MS = Math.max(30_000, PENDING_TITLE_TTL_MS)
const COMPLETION_REPLAY_GUARD_MS = 1_000
const HOOK_DONE_QUIET_MS = 1_500

function isCompletionHookState(state: ParsedAgentStatusPayload['state']): boolean {
  return state === 'done' || state === 'waiting' || state === 'blocked'
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

  function clearPollTimer(): void {
    if (pollTimer === null) {
      return
    }
    clearTimeout(pollTimer)
    pollTimer = null
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
    if (optionsOverride.quietedHookDone === true) {
      options.dispatchCompletion(title, {
        source,
        quietedHookDone: true,
        ...(optionsOverride.agentStatus ? { agentStatus: optionsOverride.agentStatus } : {})
      })
    } else {
      options.dispatchCompletion(title)
    }
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
        dispatchCompletion('process-exit', lastForegroundAgent.processName, {
          completionIdentity: {
            source: 'process-exit',
            identity: `${lastForegroundAgent.agent}:${lastForegroundAgent.processName}`,
            agentIdentity: lastForegroundAgent.agent
          }
        })
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
      dispatchCompletion('process-exit', exited.processName, {
        completionIdentity: {
          source: 'process-exit',
          identity: `${exited.agent}:${exited.processName}`,
          agentIdentity: exited.agent
        }
      })
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

  function nextPollInterval(): number {
    const base = lastForegroundAgent ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS
    const backoff =
      consecutiveInspectionErrors > 0
        ? Math.min(10_000, base * 2 ** consecutiveInspectionErrors)
        : base
    const jitter = 1 + (Math.random() * 0.2 - 0.1)
    return Math.round(backoff * jitter)
  }

  function scheduleNextPoll(): void {
    if (disposed || !options.isLive() || pollTimer !== null || pendingTitle) {
      return
    }
    if (!shouldRunCadenceInspection()) {
      return
    }
    const ptyId = options.getPtyId()
    if (!ptyId) {
      return
    }
    pollTimer = setTimeout(() => {
      pollTimer = null
      requestInspection('cadence')
    }, nextPollInterval())
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
    if (isRecognizedAgentType(payload.agentType)) {
      establishAgentEvidence()
    }
    if (payload.state === 'working') {
      clearPendingHookDone()
      workingStatusObserved = true
      requiresFreshWorking = false
      lastCompletionIdentity = null
      currentTurn += 1
      dropPendingTitle()
      return
    }
    if (isCompletionHookState(payload.state)) {
      if (payload.state !== 'done') {
        clearPendingHookDone()
      }
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
      if (payload.state === 'done' && workingStatusObserved) {
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
      dispatchCompletion(
        'hook',
        payload.agentType ?? options.paneKey,
        lastCompletionIdentity ? { completionIdentity: lastCompletionIdentity } : {}
      )
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
