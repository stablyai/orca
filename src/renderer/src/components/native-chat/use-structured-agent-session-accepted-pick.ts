import { useCallback } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  commitStructuredAgentSessionOptionValues,
  structuredAgentSessionOptionPicks,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'

const NO_HELD_OPTIONS: Readonly<Record<string, string>> = {}

/** What every accepted pick does, sent or held: commit into the record it targets and remember it
 *  as the next launch's default. */
export function useStructuredAgentSessionAcceptedPick(args: {
  agent: AgentType
  target: RuntimeClientTarget
  launchSeedOptions: Readonly<Record<string, string>> | undefined
  optionView: ReturnType<typeof useStructuredAgentSessionOptionState>['optionView']
  updateOptionState: ReturnType<typeof useStructuredAgentSessionOptionState>['updateOptionState']
}) {
  const { agent, target, launchSeedOptions, optionView, updateOptionState } = args
  return useCallback(
    (
      targetRecord: StructuredAgentSessionOptionState['record'],
      committed: Readonly<Record<string, string>>,
      pickedIn: StructuredAgentSessionOptionState
    ) => {
      updateOptionState((current) =>
        current.record === targetRecord
          ? commitStructuredAgentSessionOptionValues(current, committed)
          : current
      )
      // The launch seed names the model an effort-only pick was made under.
      const view = optionView(pickedIn, launchSeedOptions, NO_HELD_OPTIONS)
      const picks = structuredAgentSessionOptionPicks(view, committed)
      if (picks.length > 0) {
        void enqueueSessionOptionSettingsWrite(target, { type: 'apply-picks', agent, picks })
      }
    },
    [agent, launchSeedOptions, optionView, target, updateOptionState]
  )
}
