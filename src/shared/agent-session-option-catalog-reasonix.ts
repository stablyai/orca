import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

// Stable 1.39.7 model membership and effort choices belong to the user's provider configuration.
export const REASONIX_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model']),
    midSession: { kind: 'agent-picker', command: '/model' }
  }
}
