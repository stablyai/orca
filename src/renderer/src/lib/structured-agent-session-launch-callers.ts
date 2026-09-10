import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import {
  settleStructuredAgentLaunchPrompt,
  type StructuredPromptDeliveryResult
} from '@/lib/structured-agent-session-launch-prompt'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import type {
  StructuredAgentSessionLaunchOrigin,
  StructuredAgentSessionResumeSource
} from '../../../shared/structured-agent-session-create'

export type StructuredRefusalFallback = () =>
  | void
  | StructuredPromptDeliveryResult
  | Promise<void | StructuredPromptDeliveryResult>

export type StructuredAgentLaunchOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready'
  /** Reconciliation reuses the durable pre-create prompt instead of staging a second send. */
  reuseStagedPrompt?: boolean
  onPromptDelivered?: () => void
  /** Adopt an existing provider conversation instead of starting a fresh one. Part of the launch's
   *  identity, not a preference — see `launchIdentity`. */
  resumeFrom?: StructuredAgentSessionResumeSource
  launchOrigin?: StructuredAgentSessionLaunchOrigin
}

/** Includes every part of a launch that cannot safely share a pending create. */
export function structuredAgentLaunchIdentity(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: Pick<StructuredAgentLaunchOptions, 'resumeFrom' | 'launchOrigin'> = {}
): string {
  const base = options.resumeFrom
    ? `${agent}:${worktreeId}:resume:${options.resumeFrom.providerSessionId}`
    : `${agent}:${worktreeId}`
  return options.launchOrigin ? `${base}:origin:${options.launchOrigin}` : base
}

export type StructuredLaunchCaller = {
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  refusalFallback: {
    callback: StructuredRefusalFallback | null
    promise: Promise<boolean>
    resolve: (ran: boolean) => void
    reject: (error: unknown) => void
    promptDeliveryPromise: Promise<StructuredPromptDeliveryResult | null>
    resolvePromptDelivery: (result: StructuredPromptDeliveryResult | null) => void
    started: boolean
    settled: boolean
    ran: boolean
  }
}

export type StructuredLaunchCallerGroup = {
  outcome:
    | 'pending'
    | 'published'
    | 'failed'
    | 'refused'
    | 'unknown'
    | 'prompt-unknown'
    | 'cancelled'
  entries: Set<StructuredLaunchCaller>
  promptDeliveryResults: Set<Promise<StructuredPromptDeliveryResult>>
  refusalSettlement: {
    promise: Promise<boolean>
    resolve: (ran: boolean) => void
    reject: (error: unknown) => void
    settled: boolean
    failure: { error: unknown } | null
  }
  onSettled: () => void
}

export function createStructuredLaunchCallerGroup(): StructuredLaunchCallerGroup {
  const refusalSettlement = Promise.withResolvers<boolean>()
  return {
    outcome: 'pending',
    entries: new Set(),
    promptDeliveryResults: new Set(),
    refusalSettlement: {
      promise: refusalSettlement.promise,
      resolve: refusalSettlement.resolve,
      reject: refusalSettlement.reject,
      settled: false,
      failure: null
    },
    onSettled: () => {}
  }
}

function settleCallerWithoutFallback(caller: StructuredLaunchCaller): void {
  if (caller.refusalFallback.settled) {
    return
  }
  caller.refusalFallback.settled = true
  caller.refusalFallback.resolve(false)
  caller.refusalFallback.resolvePromptDelivery(null)
}

function finalizeRefusalSettlement(group: StructuredLaunchCallerGroup): void {
  if (
    group.outcome !== 'refused' ||
    group.refusalSettlement.settled ||
    [...group.entries].some((caller) => !caller.refusalFallback.settled)
  ) {
    return
  }
  group.refusalSettlement.settled = true
  if (group.refusalSettlement.failure) {
    group.refusalSettlement.reject(group.refusalSettlement.failure.error)
  } else {
    group.refusalSettlement.resolve([...group.entries].some((caller) => caller.refusalFallback.ran))
  }
  group.onSettled()
}

function runCallerRefusalFallback(
  group: StructuredLaunchCallerGroup,
  caller: StructuredLaunchCaller
): void {
  if (caller.refusalFallback.started || caller.refusalFallback.settled) {
    return
  }
  caller.refusalFallback.started = true
  const fallback = caller.refusalFallback.callback
  if (!fallback) {
    settleCallerWithoutFallback(caller)
    finalizeRefusalSettlement(group)
    return
  }
  void Promise.resolve()
    .then(fallback)
    .then(
      (result) => {
        caller.refusalFallback.ran = true
        caller.refusalFallback.resolve(true)
        caller.refusalFallback.resolvePromptDelivery(result ?? null)
      },
      (error) => {
        group.refusalSettlement.failure ??= { error }
        caller.refusalFallback.reject(error)
        caller.refusalFallback.resolvePromptDelivery(null)
      }
    )
    .finally(() => {
      caller.refusalFallback.settled = true
      finalizeRefusalSettlement(group)
    })
}

function trackPromptDelivery(
  group: StructuredLaunchCallerGroup,
  promptDeliveryResult: Promise<StructuredPromptDeliveryResult>
): void {
  group.promptDeliveryResults.add(promptDeliveryResult)
  const settled = (): void => {
    group.promptDeliveryResults.delete(promptDeliveryResult)
    group.onSettled()
  }
  void promptDeliveryResult.then((result) => {
    if (result.deliveryUnknown) {
      group.outcome = 'prompt-unknown'
    } else if (group.outcome === 'prompt-unknown') {
      group.outcome = 'published'
    }
    settled()
  }, settled)
}

export function addStructuredLaunchCaller(args: {
  group: StructuredLaunchCallerGroup
  launchResult: Promise<{ sessionId: string; fence: number }>
  options: StructuredAgentLaunchOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
}): StructuredLaunchCaller {
  const fallback = Promise.withResolvers<boolean>()
  const fallbackPromptDelivery = Promise.withResolvers<StructuredPromptDeliveryResult | null>()
  const caller: StructuredLaunchCaller = {
    refusalFallback: {
      callback: null,
      promise: fallback.promise,
      resolve: fallback.resolve,
      reject: fallback.reject,
      promptDeliveryPromise: fallbackPromptDelivery.promise,
      resolvePromptDelivery: fallbackPromptDelivery.resolve,
      started: false,
      settled: false,
      ran: false
    }
  }
  args.group.entries.add(caller)
  const promptDeliveryResult = settleStructuredAgentLaunchPrompt({
    launchResult: args.launchResult,
    options: args.options,
    stagedEntry: args.stagedEntry
  })
  caller.promptDeliveryResult = promptDeliveryResult?.catch(async (error) => {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      return (
        (await caller.refusalFallback.promptDeliveryPromise) ?? {
          delivered: false,
          failureNotified: true
        }
      )
    }
    return { delivered: false, failureNotified: true }
  })
  if (caller.promptDeliveryResult) {
    trackPromptDelivery(args.group, caller.promptDeliveryResult)
  }
  if (['published', 'prompt-unknown', 'failed', 'cancelled'].includes(args.group.outcome)) {
    settleCallerWithoutFallback(caller)
  } else if (args.group.outcome === 'refused') {
    queueMicrotask(() => runCallerRefusalFallback(args.group, caller))
  }
  return caller
}

export function settleStructuredLaunchCallersWithoutFallback(
  group: StructuredLaunchCallerGroup,
  outcome: 'published' | 'failed' | 'cancelled'
): void {
  group.outcome = outcome
  for (const caller of group.entries) {
    settleCallerWithoutFallback(caller)
  }
  if (!group.refusalSettlement.settled) {
    group.refusalSettlement.settled = true
    group.refusalSettlement.resolve(false)
  }
  group.onSettled()
}

export function settleStructuredLaunchCallersWithFallback(
  group: StructuredLaunchCallerGroup
): void {
  if (group.outcome === 'refused') {
    return
  }
  group.outcome = 'refused'
  for (const caller of group.entries) {
    runCallerRefusalFallback(group, caller)
  }
  finalizeRefusalSettlement(group)
}

export function claimStructuredLaunchCallerFallback(
  group: StructuredLaunchCallerGroup,
  caller: StructuredLaunchCaller,
  fallback: StructuredRefusalFallback
): Promise<boolean> {
  caller.refusalFallback.callback ??= fallback
  if (group.outcome === 'refused') {
    runCallerRefusalFallback(group, caller)
  }
  return caller.refusalFallback.promise
}

export function releaseStructuredLaunchCallerAfterUnknownOutcome(
  group: StructuredLaunchCallerGroup,
  caller: StructuredLaunchCaller
): boolean {
  if (group.outcome !== 'unknown' || !group.entries.delete(caller)) {
    return false
  }
  settleCallerWithoutFallback(caller)
  group.onSettled()
  return true
}

export function structuredLaunchCallersHavePendingWork(
  group: StructuredLaunchCallerGroup
): boolean {
  return (
    group.outcome === 'pending' ||
    group.outcome === 'unknown' ||
    group.outcome === 'prompt-unknown' ||
    group.promptDeliveryResults.size > 0 ||
    (group.outcome === 'refused' && !group.refusalSettlement.settled)
  )
}
