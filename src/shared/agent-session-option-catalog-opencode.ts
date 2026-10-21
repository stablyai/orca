import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

const MODEL_FLAGS = ['-m', '--model'] as const

// Why: worker-start needs launch serialization without exposing a new Native Chat option surface.
export const OPENCODE_LAUNCH_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('opencode', tokens, MODEL_FLAGS)
  }
}
