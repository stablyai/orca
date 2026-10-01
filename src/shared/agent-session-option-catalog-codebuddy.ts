import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

const CODEBUDDY_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' }
    ],
    defaultValue: 'medium'
  },
  apply: {
    launchArgs: (value) => ['--effort', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--effort'])
  }
}

export const CODEBUDDY_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Stable CLI aliases let CodeBuddy resolve the account's current model choices.
  models: [
    { id: 'default-model', label: 'Default' },
    { id: 'fast-model', label: 'Fast' },
    { id: 'balanced-model', label: 'Balanced' },
    { id: 'primary-model', label: 'Primary' },
    { id: 'deep-model', label: 'Deep' }
  ].map((model) => ({ ...model, options: [CODEBUDDY_EFFORT] })),
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model'])
  },
  unknownModelOptions: [CODEBUDDY_EFFORT]
}
