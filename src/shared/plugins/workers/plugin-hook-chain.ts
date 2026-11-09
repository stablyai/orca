import type { PluginHookName } from '../contributions/plugin-hook-contribution'
import { PLUGIN_HOOK_SPECS } from '../events/plugin-hook-payloads'
import { isPluginJsonObject } from '../manifest/plugin-json-object'
import { pluginWorkerHookDecisionSchema } from './plugin-worker-hooks'

/** What the chain decided: Orca goes on with `payload`, or a plugin refused the action. */
export type PluginHookChainOutcome =
  | { kind: 'continue'; payload: unknown }
  | { kind: 'deny'; pluginKey: string; reason: string }

export type PluginHookChainInput = {
  event: PluginHookName
  payload: unknown
  /** Plugins whose manifest lists the hook, in the order they run. */
  participants: readonly string[]
  /** Readies the plugin (starts its worker), bounded by `startTimeoutMs`, not the deadline. */
  start?: (pluginKey: string) => Promise<unknown>
  startTimeoutMs?: number
  /** Runs its handlers; rejects on crash or refusal. */
  invoke: (pluginKey: string, payload: unknown, timeoutMs: number) => Promise<unknown>
  log: (pluginKey: string, line: string) => void
  now: () => number
  /** Plugins listing the hook with `onError: "deny"`: their failure refuses the action. */
  failsClosed?: (pluginKey: string) => boolean
  deadlineMs?: number
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withinDeadline<T>(work: Promise<T>, deadlineMs: number, what = 'timed out'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} after ${deadlineMs}ms`)), deadlineMs)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** Applies only the fields the hook lets plugins change, then rechecks the whole payload. */
function applyChange(
  event: PluginHookName,
  current: unknown,
  changed: unknown
): { ok: true; payload: unknown } | { ok: false; reason: string } {
  const spec = PLUGIN_HOOK_SPECS[event]
  if (!isPluginJsonObject(current) || !isPluginJsonObject(changed)) {
    return { ok: false, reason: 'next() was given something other than the event object' }
  }
  const candidate: Record<string, unknown> = { ...current }
  for (const key of spec.mutable) {
    if (Object.hasOwn(changed, key)) {
      candidate[key] = changed[key]
    }
  }
  const parsed = spec.payload.safeParse(candidate)
  return parsed.success
    ? { ok: true, payload: parsed.data }
    : { ok: false, reason: parsed.error.issues[0]?.message ?? 'invalid change' }
}

/** Thrown for a plugin that is gone (disabled, removed, changed): it passes even when it would
 *  deny on error, since it no longer speaks for the person. */
export class PluginHookParticipantGoneError extends Error {}

/**
 * Runs a hook through each participant in order. A plugin that times out, throws, crashes or
 * answers nonsense counts as having passed (or refuses, with `onError: "deny"`), so a broken
 * plugin can delay Orca by at most its deadline.
 */
export async function runPluginHookChain(
  input: PluginHookChainInput
): Promise<PluginHookChainOutcome> {
  const { event } = input
  const spec = PLUGIN_HOOK_SPECS[event]
  const deadlineMs = input.deadlineMs ?? spec.deadlineMs
  let current = input.payload
  for (const pluginKey of input.participants) {
    const startedAt = input.now()
    const elapsed = (): number => Math.round(input.now() - startedAt)
    const failClosed = spec.result !== null && input.failsClosed?.(pluginKey) === true
    const fail = (reason: string, gone = false): PluginHookChainOutcome | null => {
      if (failClosed && !gone) {
        input.log(pluginKey, `hook ${event} denied after ${elapsed()}ms (onError: deny): ${reason}`)
        return {
          kind: 'deny',
          pluginKey,
          reason: `${pluginKey} failed and denies on error: ${reason}`
        }
      }
      input.log(pluginKey, `hook ${event} skipped after ${elapsed()}ms: ${reason}`)
      return null
    }
    let raw: unknown
    try {
      if (input.start) {
        const startTimeoutMs = input.startTimeoutMs ?? deadlineMs
        await withinDeadline(input.start(pluginKey), startTimeoutMs, 'worker did not start')
      }
      raw = await withinDeadline(input.invoke(pluginKey, current, deadlineMs), deadlineMs)
    } catch (error) {
      const denied = fail(errorText(error), error instanceof PluginHookParticipantGoneError)
      if (denied) {
        return denied
      }
      continue
    }
    const decision = pluginWorkerHookDecisionSchema.safeParse(raw)
    if (!decision.success) {
      const denied = fail('the worker answered with something other than a hook decision')
      if (denied) {
        return denied
      }
      continue
    }
    if (decision.data.decision === 'continue') {
      const change = applyChange(event, current, decision.data.payload)
      if (change.ok) {
        current = change.payload
      } else {
        input.log(pluginKey, `hook ${event}: change ignored: ${change.reason}`)
      }
      continue
    }
    if (spec.result === null) {
      continue
    }
    const result = spec.result.safeParse(decision.data.result)
    if (!result.success) {
      // Why: a malformed denial (e.g. a reason over the length cap) is the plugin failing, so a
      // guard that declared onError: "deny" must refuse instead of letting the action through.
      if (failClosed) {
        const denied = fail(`malformed result: ${result.error.issues[0]?.message ?? 'invalid'}`)
        if (denied) {
          return denied
        }
      }
      input.log(pluginKey, `hook ${event}: result ignored: return next(event) or { deny: reason }`)
      continue
    }
    return { kind: 'deny', pluginKey, reason: result.data.deny }
  }
  return { kind: 'continue', payload: current }
}
