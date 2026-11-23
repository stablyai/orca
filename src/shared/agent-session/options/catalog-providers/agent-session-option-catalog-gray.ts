import { agentChoiceCliApply } from '../../../agent-launch/choices/agent-choice-cli-apply'
import {
  GRAY_MODEL_LIST_ARGS,
  grayModelLaunchArgs,
  parseGrayModelList
} from '../model-catalog/gray-model-list-probe'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

export const GRAY_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  models: [],
  modelApply: {
    ...agentChoiceCliApply(
      'gray',
      // A raw pin need not specify both halves, so don't lift it into a picker choice.
      [{ kind: 'value', names: ['--model', '--provider'], lift: 'never', recognizes: () => false }],
      '--model'
    ),
    launchArgs: (value) => grayModelLaunchArgs(String(value))
  },
  listModels: {
    command: ['gray', ...GRAY_MODEL_LIST_ARGS].join(' '),
    parse: (stdout) => parseGrayModelList(stdout).map((model) => ({ ...model, options: [] }))
  }
}
