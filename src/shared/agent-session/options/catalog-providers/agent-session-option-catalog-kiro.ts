import { agentChoiceCliApply } from '../../../agent-launch/choices/agent-choice-cli-apply'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

const KIRO_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' }
    ],
    defaultValue: 'high'
  },
  apply: {
    ...agentChoiceCliApply(
      'kiro',
      [
        {
          kind: 'value',
          names: ['--effort'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--effort'
    )
  }
}

export const KIRO_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Model availability is account-scoped; worker-start accepts the slug reported by `kiro-cli chat --list-models`.
  models: [],
  modelApply: {
    ...agentChoiceCliApply(
      'kiro',
      [
        {
          kind: 'value',
          names: ['--model'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--model'
    ),
    midSession: { kind: 'agent-picker', command: '/model' }
  },
  unknownModelOptions: [KIRO_EFFORT]
}
