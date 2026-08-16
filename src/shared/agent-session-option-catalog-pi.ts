import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import { hasFlag } from './agent-cli-flag-detection'

export const PI_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  models: [],
  modelApply: {
    launchArgs: (model) => ['--model', String(model)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model', '-m']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model', '-m'])
  },
  // Why: Pi accepts opaque provider/model ids, so worker-start can own and later release the terminal.
  supportsWorkerLaunchPreferences: true,
  unknownModelOptions: []
}
