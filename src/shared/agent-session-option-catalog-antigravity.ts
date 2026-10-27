import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

const ANTIGRAVITY_EFFORT: CatalogOption = {
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
    launchArgs: (value) => ['--effort', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('antigravity', tokens, ['--effort']),
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

export const ANTIGRAVITY_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Model availability is account-scoped; worker-start accepts the slug reported by `agy models`.
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('antigravity', tokens, ['--model']),
    midSession: { kind: 'agent-picker', command: '/model' }
  },
  unknownModelOptions: [ANTIGRAVITY_EFFORT]
}
