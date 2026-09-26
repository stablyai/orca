import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

// `none` is omitted: native-chat-session-option-labels.ts has no translation for it.
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
    launchArgs: (value) => ['--reasoning-effort', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--reasoning-effort']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--reasoning-effort'])
  }
}

export const MUSE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: Muse model ids are account/channel-scoped and it has no listing command, so
  // seed nothing (no picker) and let worker-start pass the caller's id to `--model`.
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model'])
  },
  unknownModelOptions: [MUSE_EFFORT]
}
