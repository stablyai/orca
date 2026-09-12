import { useSyncExternalStore } from 'react'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
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
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import * as launchDraft from './structured-agent-session-launch-draft'
import { trackStructuredLaunchFailureToast } from './structured-agent-session-launch-failure-toast'

export type { StructuredAgentLaunchOptions, StructuredAgentLaunchReceipt }

type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  /** Fixed by the caller that opened this launch; a joiner delivers its text the same way. Without
   *  that, two entrypoints racing one identity seed the composer AND submit. */
  promptDelivery: StructuredAgentLaunchOptions['promptDelivery']
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
  // Any launch for this pair, not just the blank one: adopting launches carry the conversation in
  // their identity, and a caller asking "is a chat starting here" means all of them.
  const states = [
    pendingStructuredLaunchesByIdentity.get(launchIdentity(worktreeId, agent)),
    ...[...pendingStructuredLaunchesByIdentity.entries()]
      .filter(([identity]) => identity.startsWith(`${agent}:${worktreeId}:resume:`))
      .map(([, state]) => state)
  ].filter((state): state is StructuredLaunchState => Boolean(state))
  if (states.length === 0) {
    return 'idle'
  }
  return states.some((state) => state.visibilityUnknown) ? 'unknown' : 'pending'
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
//
// Why keyed by the adopted conversation as well: a joining caller is handed the EXISTING intent and
// contributes only its prompt, so without this a resume that arrives while a blank launch is pending
// would be silently dropped — the user would get a blank chat, or another row's conversation, with
// no error. A launch that adopts a conversation is a different launch.
function launchIdentity(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  resumeFrom?: StructuredAgentSessionResumeSource
): string {
  return resumeFrom
    ? `${agent}:${worktreeId}:resume:${resumeFrom.providerSessionId}`
    : `${agent}:${worktreeId}`
}

/** What the outbox must carry: a draft goes to the composer seed instead. */
function outboxPromptText(options: StructuredAgentLaunchOptions): string {
  return options.promptDelivery === 'draft' ? '' : (options.prompt?.trim() ?? '')
}

function joinLaunchDelivery(
  options: StructuredAgentLaunchOptions,
  established: StructuredAgentLaunchOptions['promptDelivery']
): StructuredAgentLaunchOptions {
  // Why: the first caller's mode wins, but with none established an absent mode reads as submit —
  // that would send a joiner's draft it never consented to send.
  const mode = established ?? options.promptDelivery
  const { promptDelivery: _joinerMode, ...rest } = options
  return mode ? { ...rest, promptDelivery: mode } : rest
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
  launchDraft.clearStructuredAgentLaunchDraft(state.intent.sessionId)
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
        // Why: the seed lives under a tab that will never open; unknown keeps it for the retry.
        launchDraft.clearStructuredAgentLaunchDraft(state.intent.sessionId)
        maybeCleanupLaunchState(state)
      } else {
        state.callers.outcome = 'unknown'
        notifyStructuredLaunchListeners()
      }
    }
  )
}

function structuredAgentLaunchState(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult {
  const identity = launchIdentity(worktreeId, agent, options.resumeFrom)
  const existing = pendingStructuredLaunchesByIdentity.get(identity)
  if (existing) {
    if (existing.visibilityUnknown) {
      existing.callers.outcome = 'pending'
      existing.promise = reconcileUnknownLaunch(existing)
      trackLaunchSettlement(existing, existing.promise)
      trackStructuredLaunchFailureToast(
        existing.intent.agent,
        existing.promise,
        existing.callers.refusalSettlement.promise
      )
      notifyStructuredLaunchListeners()
    }
    const joined = joinLaunchDelivery(options, existing.promptDelivery)
    const refusedAlready = existing.callers.outcome === 'refused'
    const text = outboxPromptText(joined)
    const stagedPrompt =
      text && !refusedAlready
        ? enqueueStructuredAgentSessionLaunchPrompt(existing.intent.sessionId, text)
        : null
    // Why: a refused launch is already settled, so nothing would ever clear a new seed — it would
    // live on under a tab that never opens.
    if (!refusedAlready) {
      launchDraft.seedStructuredAgentLaunchDraft(existing.intent.sessionId, agent, joined)
    }
    return {
      state: existing,
      caller: addStructuredLaunchCaller({
        group: existing.callers,
        launchResult: existing.promise,
        options: joined,
        stagedEntry: stagedPrompt
      })
    }
  }

  // Only pass the third argument when adopting: every ordinary launch keeps the two-argument call
  // it has always made, so this change adds no trailing `undefined` for call-site assertions to
  // absorb.
  const intent = options.resumeFrom
    ? createStructuredAgentSessionLaunchIntent(worktreeId, agent, options.resumeFrom)
    : createStructuredAgentSessionLaunchIntent(worktreeId, agent)
  const text = outboxPromptText(options)
  const stagedPrompt = text
    ? enqueueStructuredAgentSessionLaunchPrompt(intent.sessionId, text)
    : null
  launchDraft.seedStructuredAgentLaunchDraft(intent.sessionId, agent, options)
  const callers = createStructuredLaunchCallerGroup()
  const state: StructuredLaunchState = {
    identity,
    intent,
    promptDelivery: options.promptDelivery,
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
  trackStructuredLaunchFailureToast(
    state.intent.agent,
    state.promise,
    state.callers.refusalSettlement.promise
  )
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
  launchDraft.clearStructuredAgentLaunchDraft(state.intent.sessionId)
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
