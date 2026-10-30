import { agentChoiceCliApply } from './agent-choice-cli-apply'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'
import { PI_THINKING_LEVELS } from './structured-agent-session-effective-effort'

// Why: worker-start needs launch serialization; Pi's chat reads its live picker over RPC instead.
export const PI_LAUNCH_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Pi models depend on configured provider keys; ids are opaque `provider/id` selectors.
  models: [],
  modelApply: agentChoiceCliApply(
    'pi',
    [{ kind: 'value', names: ['--model'], lift: 'separate-and-long-equals' }],
    '--model'
  ),
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
