import { agentChoiceCliApply } from '../../../agent-launch/choices/agent-choice-cli-apply'
import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog-types'
import { dimaModelLaunchArgs, parseDimaModelList } from '../model-catalog/dima-model-list-probe'

/** Private enrichment-gate parser with option-free rows; actual probes run in main (agent-model-probe-spec.ts). */
function parseDimaCatalogModels(stdout: string): CatalogModel[] {
  return parseDimaModelList(stdout).map((model) => ({ ...model, options: [] }))
}

export const DIMA_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Models come from the providers dima is signed in to or holds keys for; ids are `provider/model` selectors.
  models: [],
  modelApply: {
    ...agentChoiceCliApply(
      'dima',
      [
        // Arguments never become a choice: a raw --model leans on a --provider or dima's own default.
        {
          kind: 'value',
          names: ['--model'],
          lift: 'separate-and-long-equals',
          recognizes: () => false
        },
        {
          kind: 'value',
          names: ['--provider'],
          lift: 'separate-and-long-equals',
          recognizes: () => false
        }
      ],
      '--model'
    ),
    launchArgs: (value) => dimaModelLaunchArgs(String(value))
  },
  // Only a listing proves a selector; with no daemon to ask, saved picks stay and Default runs bare `dima`.
  discoveredModelsAreAuthoritative: true,
  // No dima command lists every provider's models; the gate names the App Server read main makes.
  listModels: { command: 'provider.models.query', parse: parseDimaCatalogModels }
}
