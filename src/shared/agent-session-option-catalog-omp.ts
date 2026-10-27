import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'
import { parseOmpModelList } from './omp-model-list-probe'

/** Private enrichment-gate parser with option-free rows; actual probes parse through agent-model-probe-spec.ts. */
function parseOmpCatalogModels(stdout: string): CatalogModel[] {
  return parseOmpModelList(stdout).map((model) => ({ ...model, options: [] }))
}

export const OMP_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // OMP models depend on configured provider keys; unknown /model IDs fail. Seed none, discover picker rows, and retain the hook-reported current model.
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('omp', tokens, ['--model']),
    // OMP only opens its TUI picker for /model; our extension applies the exact selector.
    midSession: { kind: 'command', build: (value) => `/orca-model ${String(value)}` }
  },
  // Discovery must retire persisted IDs no longer listed: --model fails launch on them and there is no seed fallback.
  discoveredModelsAreAuthoritative: true,
  listModels: { command: 'omp models --json', parse: parseOmpCatalogModels }
}
