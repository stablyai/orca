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
  AgentCompletionCoordinatorOptions
} from './agent-completion-coordinator-types'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import {
  titleHasExplicitAgentIdentity,
  titleIsInconclusiveNativeDroidTitle
} from './title-agent-identity'

type CompletionSource = 'hook' | 'title' | 'process-exit'

const IDLE_POLL_INTERVAL_MS = 2_000
const ACTIVE_POLL_INTERVAL_MS = 750
const INSPECTION_TIMEOUT_MS = 15_000
const PENDING_TITLE_TTL_MS = Math.max(2_000, INSPECTION_TIMEOUT_MS + 500)
const PENDING_TITLE_MAX_TTL_MS = Math.max(30_000, PENDING_TITLE_TTL_MS)
const COMPLETION_REPLAY_GUARD_MS = 1_000

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
  let lastForegroundAgent: RecognizedAgentProcess | null = null
  let requiresFreshWorking = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pendingTitleTimer: ReturnType<typeof setTimeout> | null = null
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

  function establishAgentEvidence(): void {
    agentIdentityEstablished = true
    hasAgentRunEvidence = true
    scheduleNextPoll()
  }

  function clearAgentRunEvidence(): void {
    agentIdentityEstablished = false
    hasAgentRunEvidence = false
    workingStatusObserved = false
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

  function dispatchCompletion(source: CompletionSource, title: string): void {
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
    lastCompletionToken = token
    lastCompletionAt = now
    lastCompletedTurn = currentTurn
    lastCompletionSource = source
    workingStatusObserved = false
    options.dispatchCompletion(title)
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
    dispatchCompletion('title', title)
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
    if (lastForegroundAgent?.agent !== process.agent) {
      if (lastForegroundAgent && hasAgentRunEvidence) {
        dispatchCompletion('process-exit', lastForegroundAgent.processName)
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
      const exited = lastForegroundAgent
      dispatchCompletion('process-exit', exited.processName)
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
    if (
      lastCompletionSource === 'hook' &&
      Date.now() - lastCompletionAt < COMPLETION_REPLAY_GUARD_MS
    ) {
      return false
    }
    workingStatusObserved = true
    requiresFreshWorking = false
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
        dispatchCompletion('title', title)
      } else {
        holdTitleCompletionPending(title)
      }
    } else if (hadPendingTitle && status !== null && hasExplicitAgentIdentity) {
      // Why: a shell can briefly restore cwd between "Codex working" and
      // "Codex done"; the later explicit agent completion is authoritative.
      dropPendingTitle()
      dispatchCompletion('title', title)
    }
    lastTitleStatus = status
  }

  function observeClassifiedTitleCompletion(title: string): void {
    if (titleHasExplicitAgentIdentity(title)) {
      establishAgentEvidence()
    }
    if (agentIdentityEstablished && hasAgentRunEvidence) {
      dispatchCompletion('title', title)
    } else {
      holdTitleCompletionPending(title)
    }
  }

  function observeHookStatus(payload: ParsedAgentStatusPayload): void {
    if (isRecognizedAgentType(payload.agentType)) {
      establishAgentEvidence()
    }
    if (payload.state === 'working') {
      workingStatusObserved = true
      requiresFreshWorking = false
      currentTurn += 1
      dropPendingTitle()
      return
    }
    if (isCompletionHookState(payload.state)) {
      if (isRecognizedAgentType(payload.agentType)) {
        establishAgentEvidence()
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
      dispatchCompletion('hook', payload.agentType ?? options.paneKey)
    }
  }

  function startProcessTracking(): void {
    scheduleNextPoll()
  }

  function resetCompletionState(options: { requireFreshWorking?: boolean } = {}): void {
    dropPendingTitle()
    agentIdentityEstablished = false
    hasAgentRunEvidence = false
    workingStatusObserved = false
    lastTitleStatus = null
    lastCompletionToken = null
    lastCompletionAt = 0
    lastCompletedTurn = null
    lastCompletionSource = null
    lastForegroundAgent = null
    requiresFreshWorking = options.requireFreshWorking ?? false
    inspectionGeneration += 1
  }

  function dispose(): void {
    disposed = true
    clearPollTimer()
    dropPendingTitle()
  }

  return {
    observeTitle,
    observeClassifiedTitleCompletion,
    observeTitleWorking,
    observeHookStatus,
    startProcessTracking,
    resetCompletionState,
    dispose
  }
}
