import { normalizeHookPayload, prepareJcodeHookPayload } from './agent-hook-listener'
import {
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
export const CLAUDE_PROMPT_ID = '22222222-2222-4222-8222-222222222222'
export const CLAUDE_PREVIOUS_PROMPT_ID = '33333333-3333-4333-8333-333333333333'

export function normalizeAndAccept(
  state: HookListenerState,
  source: Parameters<typeof normalizeHookPayload>[1],
  payload: Record<string, unknown>
): ReturnType<typeof normalizeHookPayload> {
  if (source === 'jcode') {
    const prepared = prepareJcodeHookPayload(state, { paneKey: PANE_KEY, payload }, 'production')
    if (!prepared) {
      return null
    }
    const event = prepared.event
    if (event && !event.providerSessionOnly) {
      seedLegacyAgentStatusForTests(state, event)
    }
    prepared.commit()
    return event
  }
  const event = normalizeHookPayload(state, source, { paneKey: PANE_KEY, payload }, 'production')
  if (event) {
    seedLegacyAgentStatusForTests(state, event)
  }
  return event
}
