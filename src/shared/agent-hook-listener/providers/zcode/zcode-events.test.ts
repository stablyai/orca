import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../../listener-state'
import { normalizeAndAccept } from '../../normalization/agent-hook-listener-test-harness'

const SESSION_ID = 'sess_01a0caa30e777d41bad746283a45633d'
const TURN_ID = 'turn_e495d1a559aa478efba1bd75509afc'

/** ZCode fixtures include both native camelCase and Claude-compatible aliases, matching createCompatibleHookStdin on the wire. */
function zcodeEvent(
  hookEventName: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    cwd: '/tmp/ws',
    hookEventName,
    hook_event_name: hookEventName,
    mode: 'build',
    permission_mode: 'build',
    sessionId: SESSION_ID,
    session_id: SESSION_ID,
    timestamp: '2026-09-23T07:50:00.000Z',
    traceId: 'tr_1',
    turnId: TURN_ID,
    ...extra
  }
}

function toolFields(toolName: string, toolInput: unknown): Record<string, unknown> {
  return {
    toolName,
    tool_name: toolName,
    toolInput,
    tool_input: toolInput,
    toolCallId: 'call_1',
    tool_use_id: 'call_1'
  }
}

let state: HookListenerState
beforeEach(() => {
  state = createHookListenerState()
})

describe('normalizeZCodeEvent', () => {
  it.each(['PostToolUse', 'PostToolUseFailure'])(
    'returns to working after a waiting approval on %s',
    (eventName) => {
      const fields = toolFields('Bash', { command: 'pnpm test' })
      const waiting = normalizeAndAccept(state, 'zcode', zcodeEvent('PermissionRequest', fields))
      expect(waiting?.payload.state).toBe('waiting')
      expect(waiting?.payload.interactivePrompt).toContain('pnpm test')

      const event = normalizeAndAccept(state, 'zcode', zcodeEvent(eventName, fields))
      expect(event?.payload).toMatchObject({ state: 'working', agentType: 'zcode' })
      expect(event?.payload.interactivePrompt).toBeUndefined()
    }
  )
})
