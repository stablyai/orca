import { normalizeHookPayload } from './normalize-hook-payload'
import { previewHookPresence } from '../presence/agent-hook-presence-transition'
import {
  admitLegacyAgentStatus,
  createHookListenerState,
  type HookListenerState
} from '../listener-state'
import type { AgentHookEventPayload } from '../listener-event'
import type { AgentProcessIdentity } from '../../agent-status/process/agent-process-presence'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../agent-status/transport/agent-status-legacy-adapter'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

export const DROID_OWNER: AgentProcessIdentity = {
  pid: 4242,
  platform: 'darwin',
  startTime: 'Sat Oct 17 14:19:29 2026'
}
export const DROID_OTHER: AgentProcessIdentity = {
  pid: 5151,
  platform: 'darwin',
  startTime: 'Sat Oct 17 14:20:00 2026'
}

export const LEAD_ID = 'a1a1a1a1-0000-4000-8000-000000000001'
export const NEXT_LEAD_ID = 'a1a1a1a1-0000-4000-8000-000000000002'
export const CHILD_ID = 'b2b2b2b2-0000-4000-8000-000000000001'
export const SECOND_CHILD_ID = 'c3c3c3c3-0000-4000-8000-000000000001'

export type DroidHookDriver = {
  state: HookListenerState
  /** Normalizes one Droid hook and stores it the way the host would; null when the hook is dropped. */
  hook: (
    payload: Record<string, unknown>,
    process?: AgentProcessIdentity | null
  ) => AgentHookEventPayload | null
  row: () => AgentHookEventPayload | undefined
}

export function createDroidHookDriver(): DroidHookDriver {
  const driver: DroidHookDriver = {
    state: createHookListenerState(),
    hook(payload, process = DROID_OWNER) {
      const event = normalizeHookPayload(
        driver.state,
        'droid',
        {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt',
          env: 'production',
          version: '1',
          ...(process ? { agentProcess: JSON.stringify(process) } : {}),
          payload
        },
        'production'
      )
      const stored = event
        ? previewHookPresence(event, driver.state.lastStatusByPaneKey.get(event.paneKey))
            .transitioned
        : undefined
      if (
        stored &&
        !admitLegacyAgentStatus(
          driver.state,
          'main-status-update',
          stored,
          AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
        )
      ) {
        throw new Error('Droid hook row was refused')
      }
      return event
    },
    row: () => driver.state.lastStatusByPaneKey.get(PANE_KEY)
  }
  return driver
}

export const sessionStart = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'SessionStart',
  session_id: sessionId,
  source: 'startup',
  ...extra
})
export const userPrompt = (sessionId: string, prompt = 'build it') => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: sessionId,
  prompt
})
export const preTool = (sessionId: string, toolName = 'Read') => ({
  hook_event_name: 'PreToolUse',
  session_id: sessionId,
  tool_name: toolName,
  tool_input: { file_path: 'a.ts' }
})
export const postTool = (sessionId: string, toolName = 'Read') => ({
  hook_event_name: 'PostToolUse',
  session_id: sessionId,
  tool_name: toolName
})
export const stop = (sessionId: string) => ({
  hook_event_name: 'Stop',
  session_id: sessionId
})
export const sessionEnd = (sessionId: string, reason = 'other') => ({
  hook_event_name: 'SessionEnd',
  session_id: sessionId,
  reason
})
export const notification = (sessionId: string, notificationType: string, message = 'notice') => ({
  hook_event_name: 'Notification',
  session_id: sessionId,
  notification_type: notificationType,
  message
})
