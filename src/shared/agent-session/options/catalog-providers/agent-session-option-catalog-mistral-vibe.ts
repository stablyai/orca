import { agentChoiceCliApply } from '../../../agent-launch/choices/agent-choice-cli-apply'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

const VIBE_THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

export const MISTRAL_VIBE_LAUNCH_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: model aliases are defined in the user's Vibe config.
  models: [],
  modelApply: agentChoiceCliApply(
    'mistral-vibe',
    [
      {
        kind: 'value',
        names: ['--model'],
        lift: 'separate-and-long-equals',
        // Why: keep aliases in Settings Arguments as raw flags.
        recognizes: () => false
      }
    ],
    '--model'
  ),
  unknownModelOptions: [
    {
      id: 'effort',
      label: 'Reasoning effort',
      category: 'thought_level',
      kind: {
        type: 'select',
        choices: VIBE_THINKING_LEVELS.map((level) => ({ value: level, label: level })),
        // Why: Vibe config supplies the default.
        defaultValue: ''
      },
      apply: agentChoiceCliApply(
        'mistral-vibe',
        [
          {
            kind: 'value',
            names: ['--thinking'],
            lift: 'separate-and-long-equals',
            recognizes: (value) => VIBE_THINKING_LEVELS.includes(value)
          }
        ],
        '--thinking'
      )
    }
  ]
}
