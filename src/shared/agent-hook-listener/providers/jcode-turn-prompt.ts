import {
  readLastJcodeUserPromptFromHookPayload,
  type JcodeUserPromptEvidence
} from '../../jcode-session-files'
import { isNewTurnEvent } from '../provider-event-routing'
import type { HookListenerState } from '../listener-state'

/** Cache one bounded synchronous journal read per turn: jcode blocks on pre_tool. Without a pane key, read directly. */
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
