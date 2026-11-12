import { agentChoiceCliApply } from '../../agent-launch/choices/agent-choice-cli-apply'
import { parseAntigravityModels } from '../../source-control/ai/generation/commit-message-model-parsers'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'

const ANTIGRAVITY_EFFORT: CatalogOption = {
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
      'antigravity',
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

function parseAntigravityCatalogModels(stdout: string): CatalogModel[] {
  return parseAntigravityModels(stdout).map((model) => ({
    ...model,
    options: [ANTIGRAVITY_EFFORT]
  }))
}

export const ANTIGRAVITY_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Model availability is account-scoped; worker-start accepts the slug reported by `agy models`.
  models: [],
  modelApply: {
    ...agentChoiceCliApply(
      'antigravity',
      [
        {
          kind: 'value',
          names: ['--model'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--model'
    ),
    midSession: {
      kind: 'command',
      build: (value) => `/model ${String(value)}`,
      pickerCommand: '/model'
    }
  },
  discoveredModelsAreAuthoritative: true,
  unknownModelOptions: [ANTIGRAVITY_EFFORT],
  listModels: { command: 'agy models', parse: parseAntigravityCatalogModels }
}
