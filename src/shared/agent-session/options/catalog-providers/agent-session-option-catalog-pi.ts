import { agentChoiceCliApply } from '../../../agent-launch/choices/agent-choice-cli-apply'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'
import { PI_THINKING_LEVELS } from '../reconciliation/structured-agent-session-effective-effort'

/** Pi chats only accept an exact `provider/id`; its CLI fuzzy-matches anything else. */
export function isPiModelOptionId(value: string): boolean {
  const slash = value.indexOf('/')
  return slash > 0 && slash < value.length - 1
}

// Why: terminal launches need Pi's CLI flags; Pi chats keep applying picks over RPC.
export const PI_LAUNCH_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Pi models depend on configured providers; ids are opaque `provider/id` selectors.
  models: [],
  modelApply: agentChoiceCliApply(
    'pi',
    [
      {
        kind: 'value',
        names: ['--model'],
        lift: 'separate-and-long-equals',
        // Pi's CLI fuzzy-matches `--model`; chats need exact ids, so Arguments never become a model choice.
        recognizes: () => false
      }
    ],
    '--model'
  ),
  unknownModelOptions: [
    {
      id: 'effort',
      label: 'Reasoning effort',
      category: 'thought_level',
      kind: {
        type: 'select',
        choices: PI_THINKING_LEVELS.map((level) => ({ value: level, label: level })),
        // Pi's own config decides the level when none is sent.
        defaultValue: ''
      },
      apply: agentChoiceCliApply(
        'pi',
        [
          {
            kind: 'value',
            names: ['--thinking'],
            lift: 'separate-and-long-equals',
            recognizes: (value) => PI_THINKING_LEVELS.includes(value)
          }
        ],
        '--thinking'
      )
    }
  ]
}
