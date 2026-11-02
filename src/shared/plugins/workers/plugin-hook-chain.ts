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
  /** Starts the worker if needed and runs its handlers; rejects on crash or refusal. */
  invoke: (pluginKey: string, payload: unknown, timeoutMs: number) => Promise<unknown>
  log: (pluginKey: string, line: string) => void
  now: () => number
  deadlineMs?: number
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withinDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${deadlineMs}ms`)), deadlineMs)
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

/**
 * Runs a hook through each participant in order. A plugin that times out, throws, crashes or is
 * gone counts as having passed, so a broken plugin can delay Orca by at most its deadline.
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
    const skip = (reason: string): void =>
      input.log(
        pluginKey,
        `hook ${event} skipped after ${Math.round(input.now() - startedAt)}ms: ${reason}`
      )
    let raw: unknown
    try {
      raw = await withinDeadline(input.invoke(pluginKey, current, deadlineMs), deadlineMs)
    } catch (error) {
      skip(errorText(error))
      continue
    }
    const decision = pluginWorkerHookDecisionSchema.safeParse(raw)
    if (!decision.success) {
      skip('the worker answered with something other than a hook decision')
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
      input.log(pluginKey, `hook ${event}: result ignored: return next(event) or { deny: reason }`)
      continue
    }
    return { kind: 'deny', pluginKey, reason: result.data.deny }
  }
  return { kind: 'continue', payload: current }
}
