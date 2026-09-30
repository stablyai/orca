import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { KIRO_MODEL_LIST_ARGS, parseKiroModelList } from './kiro-model-list-probe'

const KIRO_EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

// Kiro documents these per-model values; unlisted models stay model-selectable without effort.
const KIRO_EFFORTS_BY_MODEL: Record<string, readonly string[]> = {
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4.8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4.7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4.6': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4.6': ['low', 'medium', 'high', 'max'],
  'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max']
}

function kiroModelOptions(modelId: string): CatalogOption[] {
  const efforts = KIRO_EFFORTS_BY_MODEL[modelId]
  if (!efforts) {
    return []
  }
  return [
    {
      id: 'effort',
      label: 'Effort',
      category: 'thought_level',
      kind: {
        type: 'select',
        choices: efforts.map((value) => ({ value, label: KIRO_EFFORT_LABELS[value] ?? value })),
        defaultValue: 'high'
      },
      apply: {
        launchArgs: (value) => ['--effort', String(value)],
        agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort']),
        removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--effort'])
      }
    }
  ]
}

function parseKiroCatalogModels(stdout: string): CatalogModel[] {
  return parseKiroModelList(stdout).map((model) => ({
    ...model,
    options: kiroModelOptions(model.id)
  }))
}

export const KIRO_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [
    {
      id: 'auto',
      label: 'Auto',
      description: 'Let Kiro choose the model for the task',
      isDefault: true,
      options: []
    }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model'])
  },
  resolveModelOptions: kiroModelOptions,
  launchOptionDefaults: false,
  discoveredModelsAreAuthoritative: true,
  discoveredModelOptionsAreAuthoritative: true,
  defaultModelIsCliDefault: true,
  listModels: {
    command: `kiro-cli ${KIRO_MODEL_LIST_ARGS.join(' ')}`,
    parse: parseKiroCatalogModels
  }
}
