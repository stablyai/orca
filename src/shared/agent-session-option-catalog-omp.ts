import { removeAgentArgOption } from './agent-session-option-agent-args'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { OMP_THINKING_LEVELS, parseOmpModelList } from './omp-model-list-probe'

export const OMP_CONFIG_DEFAULT_THINKING = 'config-default'

export function createOmpCatalogOptions(
  levels: readonly { id: string; label: string }[]
): CatalogOption[] {
  if (!levels.length) {
    return []
  }
  return [
    {
      id: 'effort',
      label: 'Thinking',
      category: 'thought_level',
      kind: {
        type: 'select',
        choices: [
          { value: OMP_CONFIG_DEFAULT_THINKING, label: 'Config default' },
          ...levels.map(({ id, label }) => ({ value: id, label }))
        ],
        defaultValue: OMP_CONFIG_DEFAULT_THINKING
      },
      apply: {
        launchArgs: (value) => ['--thinking', String(value)],
        removeAgentArgs: (tokens) => removeAgentArgOption('omp', tokens, ['--thinking']),
        // The extension API reports effective ThinkingLevel, not the configured auto policy.
        midSession: { kind: 'unsupported' }
      }
    }
  ]
}

function parseOmpCatalogModels(stdout: string): CatalogModel[] {
  return parseOmpModelList(stdout).map((model) => ({
    ...model,
    options: createOmpCatalogOptions(model.thinkingLevels ?? [])
  }))
}

export const OMP_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: OMP's selectable models are whatever providers the user configured keys
  // for — no id is available on every install, and `/model` rejects an unknown
  // one. Seed nothing: desktop fills the picker from discovery, and every surface
  // keeps the row the hook reports as the session's current model.
  models: [],
  // Opaque worker ids accept native CLI selectors; OMP owns model-specific clamping.
  unknownModelOptions: createOmpCatalogOptions(
    OMP_THINKING_LEVELS.map((id) => ({ id, label: id }))
  ),
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('omp', tokens, ['--model']),
    // OMP only opens its TUI picker for /model; our extension applies the exact selector.
    midSession: { kind: 'command', build: (value) => `/orca-model ${String(value)}` }
  },
  // Why: with no seed there is nothing to keep; a persisted id the host no longer
  // lists is a fatal `--model` at launch, so discovery must be able to retire it.
  discoveredModelsAreAuthoritative: true,
  liveModelOptionsAreAuthoritative: true,
  listModels: { command: 'omp models --json', parse: parseOmpCatalogModels }
}
