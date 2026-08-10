import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'
import { parseDroidModelList } from './droid-model-list-probe'

function parseDroidCatalogModels(stdout: string): CatalogModel[] {
  return parseDroidModelList(stdout).map((model) => ({ ...model, options: [] }))
}

export const DROID_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why empty: interactive `droid` publishes no model list of its own and — verified
  // against v0.191.1 — silently ignores unknown flags, so a seeded row would claim a
  // choice the launch cannot make and never error. The once-per-host probe supplies
  // the account's real list, and until it lands there is no model pill at all.
  models: [],
  modelApply: {
    // Why no launchArgs: `-m/--model` exists only on `droid exec`. Passing it to the
    // interactive CLI is dropped without warning, so the draft honestly reports the
    // model as available only after the session starts.
    //
    // Why agent-picker: `/model` opens Droid's own selector pane and takes no
    // argument, and the selection is never echoed back, so no command can carry a
    // model id and no dispatch result could be trusted as the new value.
    midSession: { kind: 'agent-picker', command: '/model' }
  },
  // Reasoning effort is deliberately absent: `droid exec` takes `-r`, but the
  // interactive CLI has neither the flag nor a slash command for it, so every
  // surface would render a control that can never apply.
  listModels: { command: 'droid exec --help', parse: parseDroidCatalogModels }
}
