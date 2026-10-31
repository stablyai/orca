import { agentChoiceCliApply } from './agent-choice-cli-apply'
import type {
  AgentSessionOptionCatalog,
  CatalogOptionApply
} from './agent-session-option-catalog-types'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import { PI_THINKING_LEVELS } from './structured-agent-session-effective-effort'

// Why: worker-start and `agent launch` need launch serialization; a Pi chat reads its live picker over RPC instead.
export const PI_LAUNCH_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Pi models depend on configured provider keys; ids are opaque `provider/id` selectors.
  models: [],
  modelApply: piModelApply(),
  // Pi maps a level per model through `thinkingLevelMap` and clamps what a model cannot run, so the
  // menu cannot be scoped to a model here; the receipt records the level the launch asked for.
  unknownModelOptions: [
    {
      id: 'effort',
      label: 'Thinking level',
      category: 'thought_level',
      kind: {
        type: 'select',
        choices: PI_THINKING_LEVELS.map((level) => ({ value: level, label: level })),
        defaultValue: 'medium'
      },
      apply: agentChoiceCliApply(
        'pi',
        [{ kind: 'value', names: ['--thinking'], lift: 'separate-and-long-equals' }],
        '--thinking'
      )
    }
  ]
}

function piModelApply(): CatalogOptionApply {
  // Pi spells the model flag both ways, so a configured `-m` must yield too.
  const model = agentChoiceCliApply(
    'pi',
    [{ kind: 'value', names: ['-m', '--model'], lift: 'separate-and-long-equals' }],
    '--model'
  )
  return {
    ...model,
    // Pi pins the configured model to its `--provider`; keeping that pin would constrain the new pick.
    removeAgentArgs: (tokens) =>
      removeAgentArgOption('pi', removeAgentArgOption('pi', tokens, ['-m', '--model']), [
        '--provider'
      ])
  }
}
