import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  abandonStructuredAgentSessionLaunchIntent,
  createStructuredAgentSessionLaunchIntent,
  StructuredAgentSessionCreateRefusalError
} from '@/lib/launch-structured-agent-session'
import {
  discardStructuredAgentSessionLaunchOutbox,
  enqueueStructuredAgentSessionLaunchPrompt
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  launchAndReconcile,
  reconcileUnknownLaunch,
  StructuredAgentSessionLaunchCancelledError,
  type StructuredAgentLaunchReceipt,
  type StructuredLaunchRecoveryState
} from '@/lib/structured-agent-session-launch-recovery'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import {
  addStructuredLaunchCaller,
  claimStructuredLaunchCallerFallback,
  createStructuredLaunchCallerGroup,
  releaseStructuredLaunchCallerAfterUnknownOutcome,
  settleStructuredLaunchCallersWithFallback,
  settleStructuredLaunchCallersWithoutFallback,
  structuredLaunchCallersHavePendingWork,
  type StructuredAgentLaunchOptions,
  type StructuredLaunchCaller,
  type StructuredLaunchCallerGroup,
  type StructuredRefusalFallback
} from '@/lib/structured-agent-session-launch-callers'

export type { StructuredAgentLaunchOptions, StructuredAgentLaunchReceipt }

type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  callers: StructuredLaunchCallerGroup
}

type StructuredLaunchStateResult = {
  state: StructuredLaunchState
  caller: StructuredLaunchCaller
}

export type StructuredAgentLaunchResult = {
  sessionId: string
  launchResult: Promise<StructuredAgentLaunchReceipt>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  isVisibilityUnknown: () => boolean
  releaseCallerAfterUnknownOutcome: () => boolean
  claimDefinitiveRefusalFallback: (fallback: StructuredRefusalFallback) => Promise<boolean>
}

export type StructuredAgentLaunchStatus = 'idle' | 'pending' | 'unknown'

function structuredAgentLabel(agent: AgentSessionHandleProvider): string {
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
}

const pendingStructuredLaunchesByIdentity = new Map<string, StructuredLaunchState>()
const structuredLaunchListeners = new Set<() => void>()

function notifyStructuredLaunchListeners(): void {
  for (const listener of structuredLaunchListeners) {
    listener()
  }
}

export function subscribeStructuredAgentLaunchStatus(listener: () => void): () => void {
  structuredLaunchListeners.add(listener)
  return () => structuredLaunchListeners.delete(listener)
}

export function getStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  const state = pendingStructuredLaunchesByIdentity.get(launchIdentity(worktreeId, agent))
  if (!state) {
    return 'idle'
  }
  return state.visibilityUnknown ? 'unknown' : 'pending'
}

export function useStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentLaunchStatus(worktreeId, agent),
    () => 'idle'
  )
}

// Why keyed by agent too: one worktree can hold a Claude and a Codex launch at once, and a shared
// key would hand the second caller the first agent's intent.
function launchIdentity(worktreeId: string, agent: AgentSessionHandleProvider): string {
  return `${agent}:${worktreeId}`
}

function cleanupLaunchState(state: StructuredLaunchState): void {
  if (pendingStructuredLaunchesByIdentity.get(state.identity) === state) {
    pendingStructuredLaunchesByIdentity.delete(state.identity)
    notifyStructuredLaunchListeners()
  }
}

function maybeCleanupLaunchState(state: StructuredLaunchState): void {
  if (structuredLaunchCallersHavePendingWork(state.callers)) {
    return
  }
  cleanupLaunchState(state)
}

function settleDefinitiveRefusalFallback(state: StructuredLaunchState): void {
  if (state.callers.outcome === 'refused') {
    return
  }
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  settleStructuredLaunchCallersWithFallback(state.callers)
}

function trackLaunchSettlement(
  state: StructuredLaunchState,
  promise: Promise<StructuredAgentLaunchReceipt>
): void {
  void promise.then(
    () => {
      if (state.promise !== promise) {
        return
      }
      settleStructuredLaunchCallersWithoutFallback(state.callers, 'published')
      maybeCleanupLaunchState(state)
    },
    (error) => {
      if (state.promise !== promise || state.cancelled) {
        return
      }
      if (error instanceof StructuredAgentSessionCreateRefusalError) {
        settleDefinitiveRefusalFallback(state)
      } else if (!state.visibilityUnknown) {
        settleStructuredLaunchCallersWithoutFallback(state.callers, 'failed')
        maybeCleanupLaunchState(state)
      } else {
        state.callers.outcome = 'unknown'
        notifyStructuredLaunchListeners()
      }
    }
  )
}

function trackLaunchFailureToast(state: StructuredLaunchState): void {
  void state.promise.catch(async (error) => {
    if (error instanceof StructuredAgentSessionLaunchCancelledError) {
      return
    }
    const agentLabel = structuredAgentLabel(state.intent.agent)
    if (
      error instanceof StructuredAgentSessionCreateRefusalError &&
      (await state.callers.refusalSettlement.promise.catch(() => false))
    ) {
      // Why: the callback proves the fallback was attempted, not that its terminal became visible.
      toast.message(
        translate(
          'components.native-chat.structuredSessionFellBackToTerminal',
          "Structured chat isn't available"
        ),
        {
          description: translate(
            'components.native-chat.structuredSessionFellBackToTerminalDescription',
            'Orca tried to open a {{value0}} terminal instead.',
            { value0: agentLabel }
          )
        }
      )
      return
    }
    // Why: the raw error carries errnos and absolute paths; it belongs in the log, not the toast.
    console.warn('[native-chat] structured launch failed', error)
    toast.error(
      translate(
        'components.native-chat.structuredSessionLaunchFailed',
        'Could not open {{value0}} chat',
        {
          value0: agentLabel
        }
      ),
      {
        description: translate(
          'components.native-chat.structuredSessionLaunchFailedDescription',
          'Orca could not open a structured {{value0}} chat. See the logs for details.',
          { value0: agentLabel }
        )
      }
    )
  })
}

function structuredAgentLaunchState(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult {
  const identity = launchIdentity(worktreeId, agent)
  const existing = pendingStructuredLaunchesByIdentity.get(identity)
  if (existing) {
    if (existing.visibilityUnknown) {
      existing.callers.outcome = 'pending'
      existing.promise = reconcileUnknownLaunch(existing)
      trackLaunchSettlement(existing, existing.promise)
      trackLaunchFailureToast(existing)
      notifyStructuredLaunchListeners()
    }
    const text = options.prompt?.trim() ?? ''
    const stagedPrompt =
      text && existing.callers.outcome !== 'refused'
        ? enqueueStructuredAgentSessionLaunchPrompt(existing.intent.sessionId, text)
        : null
    return {
      state: existing,
      caller: addStructuredLaunchCaller({
        group: existing.callers,
        launchResult: existing.promise,
        options,
        stagedEntry: stagedPrompt
      })
    }
  }

  const intent = createStructuredAgentSessionLaunchIntent(worktreeId, agent)
  const text = options.prompt?.trim() ?? ''
  const stagedPrompt = text
    ? enqueueStructuredAgentSessionLaunchPrompt(intent.sessionId, text)
    : null
  const callers = createStructuredLaunchCallerGroup()
  const state: StructuredLaunchState = {
    identity,
    intent,
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    visibilityUnknown: false,
    cancelled: false,
    onVisibilityChanged: notifyStructuredLaunchListeners,
    callers
  }
  callers.onSettled = () => maybeCleanupLaunchState(state)
  state.promise =
    text && !stagedPrompt
      ? Promise.reject(
          new StructuredAgentSessionCreateRefusalError(
            `Could not durably stage the ${structuredAgentLabel(agent)} launch prompt.`
          )
        )
      : launchAndReconcile(state)
  const caller = addStructuredLaunchCaller({
    group: state.callers,
    launchResult: state.promise,
    options,
    stagedEntry: stagedPrompt
  })
  pendingStructuredLaunchesByIdentity.set(identity, state)
  notifyStructuredLaunchListeners()
  trackLaunchSettlement(state, state.promise)
  trackLaunchFailureToast(state)
  return {
    state,
    caller
  }
}

export function cancelStructuredAgentLaunch(worktreeId: string, sessionId: string): boolean {
  const state = [...pendingStructuredLaunchesByIdentity.values()].find(
    (candidate) =>
      candidate.intent.worktreeId === worktreeId && candidate.intent.sessionId === sessionId
  )
  if (!state) {
    return false
  }
  state.cancelled = true
  settleStructuredLaunchCallersWithoutFallback(state.callers, 'cancelled')
  cleanupLaunchState(state)
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  notifyStructuredLaunchListeners()
  return true
}

export function startStructuredAgentLaunch(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions = {}
): StructuredAgentLaunchResult {
  const { state, caller } = structuredAgentLaunchState(worktreeId, agent, options)
  return {
    sessionId: state.intent.sessionId,
    launchResult: state.promise,
    ...(caller.promptDeliveryResult ? { promptDeliveryResult: caller.promptDeliveryResult } : {}),
    isVisibilityUnknown: () => state.visibilityUnknown,
    releaseCallerAfterUnknownOutcome: () =>
      releaseStructuredLaunchCallerAfterUnknownOutcome(state.callers, caller),
    claimDefinitiveRefusalFallback: (fallback) =>
      claimStructuredLaunchCallerFallback(state.callers, caller, fallback)
  }
}
