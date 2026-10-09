import { removeAgentArgOption } from './agent-session-option-agent-args'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { PI_THINKING_LEVELS, parsePiModelList } from './pi-model-list-probe'

/** Orca's `effort` reaches Pi as `--thinking`; the choice list is Pi's flag domain verbatim. */
const PI_THINKING: CatalogOption = {
  id: 'effort',
  label: 'Thinking',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: PI_THINKING_LEVELS.map((level) => ({
      value: level.id,
      label: level.label
    })),
    defaultValue: 'low'
  },
  apply: {
    launchArgs: (value) => ['--thinking', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('pi', tokens, ['--thinking'])
  }
}

/** Catalog rows for `pi --list-models` output; the launch surface carries no per-model options. */
function parsePiCatalogModels(stdout: string): CatalogModel[] {
  return parsePiModelList(stdout).map((model) => ({
    id: model.id,
    label: model.label,
    options: []
  }))
}

export const PI_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: Pi's selectable models are whatever providers the host is logged into —
  // no id is available on every install, so the seed stays empty and discovery
  // fills the picker. A persisted id a probe no longer lists is a fatal
  // `--model` at launch, so discovery must be able to retire it.
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('pi', tokens, ['--model'])
  },
  unknownModelOptions: [PI_THINKING],
  discoveredModelsAreAuthoritative: true,
  listModels: { command: 'pi --list-models', parse: parsePiCatalogModels }
}
