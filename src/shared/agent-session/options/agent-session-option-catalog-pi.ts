import { agentChoiceCliApply } from '../../agent-launch/choices/agent-choice-cli-apply'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

// Why: terminal launches need Pi's `--model`; Pi chats keep applying picks over RPC.
export const PI_LAUNCH_OPTION_CATALOG: AgentSessionOptionCatalog = {
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
  )
}
