import { agentChoiceCliApply } from '../../agent-launch/choices/agent-choice-cli-apply'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { parseOmpModelList } from '../../omp-model-list-probe'

/** Private enrichment-gate parser with option-free rows; actual probes parse through agent-model-probe-spec.ts. */
function parseOmpCatalogModels(stdout: string): CatalogModel[] {
  return parseOmpModelList(stdout).map((model) => ({ ...model, options: [] }))
}

// Every level `omp --thinking` accepts.
const OMP_THINKING: CatalogOption = {
  id: 'effort',
  label: 'Thinking',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'off', label: 'Off' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
      { value: 'auto', label: 'Auto' }
    ],
    // OMP's own config decides the level when none is sent; no listed choice stands for it.
    defaultValue: ''
  },
  apply: agentChoiceCliApply(
    'omp',
    [{ kind: 'value', names: ['--thinking'], lift: 'separate-and-long-equals' }],
    '--thinking'
  )
}

export const OMP_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // OMP models depend on configured provider keys; unknown /model IDs fail. Seed none, discover picker rows, and retain the hook-reported current model.
  models: [],
  modelApply: {
    ...agentChoiceCliApply(
      'omp',
      [
        {
          kind: 'value',
          names: ['--model'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--model'
    ),
    // OMP only opens its TUI picker for /model; our extension applies the exact selector.
    midSession: { kind: 'command', build: (value) => `/orca-model ${String(value)}` }
  },
  // Saved model IDs remain launch selections even when discovery no longer lists them.
  discoveredModelsAreAuthoritative: true,
  unknownModelOptions: [OMP_THINKING],
  listModels: { command: 'omp models --json', parse: parseOmpCatalogModels }
}
