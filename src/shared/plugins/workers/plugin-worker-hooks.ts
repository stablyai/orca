import { z } from 'zod'
import { PLUGIN_HOOK_NAMES } from '../contributions/plugin-hook-contribution'

/** What `next(event)` returns: the handler returns it to let the chain go on. */
class PluginHookContinue {
  constructor(readonly event: unknown) {}
}

export type PluginHookNext = (event?: unknown) => PluginHookContinue
export type PluginHookHandler = (event: unknown, next: PluginHookNext) => unknown

export const pluginWorkerHookParamsSchema = z.object({
  event: z.enum(PLUGIN_HOOK_NAMES),
  payload: z.unknown()
})

/** One worker's verdict: go on with (possibly changed) `payload`, or stop with `result`. */
export const pluginWorkerHookDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('continue'), payload: z.unknown() }),
  z.object({ decision: z.literal('result'), result: z.unknown() })
])

export type PluginWorkerHookDecision = z.infer<typeof pluginWorkerHookDecisionSchema>

/** Runs one worker's handlers for a hook in registration order; the host validates the outcome. */
export async function runPluginWorkerHookHandlers(
  handlers: Iterable<PluginHookHandler>,
  payload: unknown
): Promise<PluginWorkerHookDecision> {
  let current = payload
  for (const handler of handlers) {
    const next: PluginHookNext = (event) => new PluginHookContinue(event ?? current)
    const returned = await handler(current, next)
    if (returned instanceof PluginHookContinue) {
      current = returned.event
    } else if (returned !== undefined && returned !== null) {
      return { decision: 'result', result: returned }
    }
  }
  return { decision: 'continue', payload: current }
}
