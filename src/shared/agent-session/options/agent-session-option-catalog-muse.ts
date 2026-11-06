import { agentChoiceCliApply } from '../../agent-launch/choices/agent-choice-cli-apply'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

// `none` is omitted: the meta provider rejects it (`/effort none` reports it unsupported).
const MUSE_EFFORT: CatalogOption = {
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
      { value: 'max', label: 'Max' },
      { value: 'ultra', label: 'Ultra' }
    ],
    defaultValue: 'high'
  },
  apply: {
    ...agentChoiceCliApply(
      'muse',
      [
        {
          kind: 'value',
          names: ['--reasoning-effort'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--reasoning-effort'
    ),
    // The TUI takes `/effort <level>` inline and echoes it on its status line.
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

export const MUSE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Muse has account-scoped IDs and no listing command: seed no picker; let worker-start pass the caller's --model.
  models: [],
  modelApply: {
    ...agentChoiceCliApply(
      'muse',
      [
        {
          kind: 'value',
          names: ['--model'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--model'
    )
  },
  unknownModelOptions: [MUSE_EFFORT]
}
