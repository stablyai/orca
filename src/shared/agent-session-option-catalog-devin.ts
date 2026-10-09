import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'
import { DEVIN_MODEL_LIST_ARGS, parseDevinModelList } from './devin-model-list-probe'

/** Catalog rows for `devin models list --format json` output; Devin models carry no options. */
function parseDevinCatalogModels(stdout: string): CatalogModel[] {
  return parseDevinModelList(stdout).map((model) => ({
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
    options: []
  }))
}

export const DEVIN_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: Devin's models are whatever the account lists — no id is available on
  // every install, so the seed stays empty and discovery fills the picker. A
  // persisted id a probe no longer lists is a fatal `--model` at launch, so
  // discovery must be able to retire it. Effort is part of the model id
  // (`swe-2-medium`, `claude-fable-5-1-low`), so no option is offered.
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption('devin', tokens, ['--model'])
  },
  discoveredModelsAreAuthoritative: true,
  listModels: {
    command: `devin ${DEVIN_MODEL_LIST_ARGS.join(' ')}`,
    parse: parseDevinCatalogModels
  }
}
