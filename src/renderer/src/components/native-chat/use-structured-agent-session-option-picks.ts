import { useCallback } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  structuredAgentSessionOptionPicks,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'

export function useRememberSessionOptionPicks(target: RuntimeClientTarget, agent: AgentType) {
  return useCallback(
    (view: StructuredAgentSessionOptionState, committed: Readonly<Record<string, string>>) => {
      const picks = structuredAgentSessionOptionPicks(view, committed)
      if (picks.length > 0) {
        void enqueueSessionOptionSettingsWrite(target, { type: 'apply-picks', agent, picks })
      }
    },
    [agent, target]
  )
}
