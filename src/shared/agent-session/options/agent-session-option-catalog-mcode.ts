import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'
import { agentChoiceCliApply } from '../../agent-launch/choices/agent-choice-cli-apply'

const MCODE_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ],
    defaultValue: 'high'
  },
  apply: {
    ...agentChoiceCliApply(
      'mcode',
      [
        {
          kind: 'value',
          names: ['--effort'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--effort'
    ),
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

export const MCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [
    {
      id: 'minimax/MiniMax-M3',
      label: 'MiniMax M3',
      contextWindowTokens: 1_000_000,
      isDefault: true,
      options: [MCODE_EFFORT]
    },
    {
      id: 'minimax/MiniMax-M3.1-flash',
      label: 'MiniMax M3.1 Flash',
      contextWindowTokens: 1_000_000,
      options: [MCODE_EFFORT]
    }
  ],
  modelApply: {
    ...agentChoiceCliApply(
      'mcode',
      [
        {
          kind: 'value',
          names: ['-m', '--model'],
          lift: 'separate-and-long-equals'
        }
      ],
      '-m'
    ),
    midSession: { kind: 'agent-picker', command: '/model' }
  },
  unknownModelOptions: [MCODE_EFFORT]
}
