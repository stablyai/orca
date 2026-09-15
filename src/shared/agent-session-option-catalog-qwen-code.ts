import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

const MODEL_FLAGS = ['-m', '--model'] as const

export const QWEN_CODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, MODEL_FLAGS),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, MODEL_FLAGS)
  }
}
