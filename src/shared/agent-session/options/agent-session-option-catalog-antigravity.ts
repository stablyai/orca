import { agentChoiceCliApply } from '../../agent-launch/choices/agent-choice-cli-apply'
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
    midSession: { kind: 'agent-picker', command: '/model' }
  },
  unknownModelOptions: [ANTIGRAVITY_EFFORT]
}

// Why: agy's terminal model ids already name their effort, and a second `--effort` that doesn't
// match makes the TUI silently start its default model. Terminals offer no effort (no choices);
// an effort already saved still launches as saved. Chat keeps the per-model effort menu.
export const ANTIGRAVITY_LAUNCH_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: ANTIGRAVITY_SESSION_OPTION_CATALOG.modelApply,
  unknownModelOptions: [
    { ...ANTIGRAVITY_EFFORT, kind: { type: 'select', choices: [], defaultValue: '' } }
  ]
}
