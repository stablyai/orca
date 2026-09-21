import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { KIRO_MODEL_LIST_ARGS, parseKiroModelList } from './kiro-model-list-probe'

const KIRO_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Effort',
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
    launchArgs: (value) => ['--effort', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--effort'])
  }
}

function parseKiroCatalogModels(stdout: string): CatalogModel[] {
  return parseKiroModelList(stdout).map((model) => ({ ...model, options: [KIRO_EFFORT] }))
}

export const KIRO_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [
    {
      id: 'auto',
      label: 'Auto',
      description: 'Let Kiro choose the model for the task',
      isDefault: true,
      options: [KIRO_EFFORT]
    }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model'])
  },
  unknownModelOptions: [KIRO_EFFORT],
  discoveredModelsAreAuthoritative: true,
  defaultModelIsCliDefault: true,
  listModels: {
    command: `kiro-cli ${KIRO_MODEL_LIST_ARGS.join(' ')}`,
    parse: parseKiroCatalogModels
  }
}
