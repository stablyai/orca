import { agentChoiceCliApply } from './agent-choice-cli-apply'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

// Why: worker-start needs launch serialization without exposing a new Native Chat option surface.
export const OPENCODE_LAUNCH_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    ...agentChoiceCliApply(
      'opencode',
      [
        {
          kind: 'value',
          names: ['-m', '--model'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--model'
    )
  }
}
