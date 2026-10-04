import {
  readLastJcodeUserPromptFromHookPayload,
  type JcodeUserPromptEvidence
} from '../../jcode-session-files'
import { isNewTurnEvent } from '../provider-event-routing'
import type { HookListenerState } from '../listener-state'

/**
 * Journal-backed prompt for the pane's current jcode turn.
 *
 * Why cached: the read is a synchronous bounded file scan plus a JSON parse, and jcode
 * blocks on the pre_tool hook — re-reading per tool call charges the user that latency
 * on every tool it runs. Only a new turn can change the answer, so one read per turn is
 * enough. A pane with no key has nowhere to cache and keeps the direct read.
 */
export function readJcodeTurnPrompt(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  hookPayload: Record<string, unknown>
): JcodeUserPromptEvidence | null {
  if (!paneKey) {
    return readLastJcodeUserPromptFromHookPayload(hookPayload)
  }
  const cache = state.jcodeTurnPromptByPaneKey
  if (isNewTurnEvent('jcode', eventName) || !cache.has(paneKey)) {
    cache.set(paneKey, readLastJcodeUserPromptFromHookPayload(hookPayload))
  }
  return cache.get(paneKey) ?? null
}
