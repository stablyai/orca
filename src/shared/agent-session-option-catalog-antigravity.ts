import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'
import { parseAntigravityModels } from './commit-message-model-parsers'

const EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

function modelOptions(modelId: string): CatalogOption[] {
  const fixedEffort = /^gemini-[\w.-]+-(low|medium|high)$/.exec(modelId)?.[1]
  const choices = fixedEffort
    ? EFFORT_CHOICES.filter(({ value }) => value === fixedEffort)
    : /^gemini-3\.[678]-flash$/.test(modelId)
      ? EFFORT_CHOICES
      : modelId === 'gemini-3.1-pro'
        ? EFFORT_CHOICES.filter(({ value }) => value !== 'medium')
        : []
  if (choices.length === 0) {
    return []
  }
  return [
    {
      id: 'effort',
      label: 'Effort',
      category: 'thought_level',
      kind: { type: 'select', choices, defaultValue: fixedEffort ?? 'low' },
      apply: {
        launchArgs: (value) => ['--effort', String(value)],
        agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort']),
        removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--effort']),
        midSession: { kind: 'unsupported' }
      }
    }
  ]
}

export const ANTIGRAVITY_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  resolveModelOptions: modelOptions,
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model', '--effort']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model', '--effort']),
    midSession: { kind: 'unsupported' }
  },
  discoveredModelsAreAuthoritative: true,
  listModels: {
    command: 'agy models',
    parse: (stdout) =>
      parseAntigravityModels(stdout).map((model) => ({ ...model, options: modelOptions(model.id) }))
  }
}
