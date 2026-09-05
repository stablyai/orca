import { hasFlag } from './agent-cli-flag-detection'
import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'
import { parseOmpModelList } from './omp-model-list-probe'

/** Catalog rows for `omp models --json` output; every OMP model carries no options.
 *  The enrichment gate reads only `listModels`' presence; the probe itself parses
 *  through `agent-model-probe-spec.ts`, so keep this private to that gate. */
function parseOmpCatalogModels(stdout: string): CatalogModel[] {
  return parseOmpModelList(stdout).map((model) => ({ ...model, options: [] }))
}

export const OMP_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why: OMP's selectable models are whatever providers the user configured keys
  // for — no id is available on every install, and `/model` rejects an unknown
  // one. Seed nothing: desktop fills the picker from discovery, and every surface
  // keeps the row the hook reports as the session's current model.
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    // Why: `/model <provider/id>` resolves exactly on the selector, so the switch
    // needs no picker round-trip through the TUI.
    midSession: { kind: 'command', build: (value) => `/model ${String(value)}` }
  },
  // Why: with no seed there is nothing to keep; a persisted id the host no longer
  // lists is a fatal `--model` at launch, so discovery must be able to retire it.
  discoveredModelsAreAuthoritative: true,
  listModels: { command: 'omp models --json', parse: parseOmpCatalogModels }
}
