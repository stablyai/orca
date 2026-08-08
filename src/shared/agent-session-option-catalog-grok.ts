import { hasFlag } from './agent-cli-flag-detection'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { parseGrokModelList } from './grok-model-list-probe'

const GROK_EFFORT: CatalogOption = {
  // Why: `LaunchPreferences` is a strict zod object over model/effort/mode, so a
  // novel id is dropped client-side and rejected on the wire.
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    // Why: only values `native-chat-session-option-labels.ts` localizes; grok's
    // `none` tier and per-model menu ids would render untranslated.
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ],
    defaultValue: 'high'
  },
  apply: {
    launchArgs: (value) => ['--reasoning-effort', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort', '--reasoning-effort']),
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

// The enrichment gate reads only `listModels`' presence; the probe itself parses
// through `agent-model-probe-spec.ts`, so keep this private to that gate.
function parseGrokCatalogModels(stdout: string): CatalogModel[] {
  return parseGrokModelList(stdout).map((model) => ({ ...model, options: [] }))
}

export const GROK_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why: Grok model access depends on the signed-in account and on [model.*]
  // config. Seed only what is verified; discovery supplies the rest.
  models: [
    {
      id: 'grok-4.5',
      label: 'Grok 4.5',
      description: "xAI's frontier model",
      isDefault: true,
      options: [GROK_EFFORT]
    }
  ],
  modelApply: {
    launchArgs: (value) => ['-m', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    // Why: `agent-picker` would replace the whole model list with "Choose in
    // agent picker…" and never persist a model, so `-m` would never be emitted.
    midSession: { kind: 'command', build: (value) => `/model ${String(value)}` }
  },
  // Why: grok's selectable ids retire between releases, so a stale seed entry
  // must be droppable — picking one is a fatal launch, not a warning.
  discoveredModelsAreAuthoritative: true,
  // Why: `grok models` prints `Default model: grok-4.5` and marks the row `(default)`,
  // so the seed states the CLI's own choice rather than a preference of ours.
  defaultModelIsCliDefault: true,
  listModels: { command: 'grok models', parse: parseGrokCatalogModels }
}
