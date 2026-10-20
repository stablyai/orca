import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

// DSH's configured providers own both model ids and model-specific effort values.
export const DSH_LAUNCH_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('dsh', tokens, ['--model'])
  },
  unknownModelOptions: [
    {
      id: 'effort',
      label: 'Effort',
      kind: { type: 'select', choices: [], defaultValue: '', validateOnAgentLaunch: true },
      apply: {
        launchArgs: (value) => ['--effort', String(value)],
        removeAgentArgs: (tokens) => removeAgentArgOption('dsh', tokens, ['--effort'])
      }
    }
  ]
}
