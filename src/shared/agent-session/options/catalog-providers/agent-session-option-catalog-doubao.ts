import type { CommitMessageModelCapability } from '../../../source-control/ai/generation/commit-message-agent-spec'
import { agentChoiceCliApply } from '../../../agent-launch/choices/agent-choice-cli-apply'
import {
  DOUBAO_EFFORT_LEVELS,
  parseDoubaoModelList
} from '../model-catalog/doubao-model-list-probe'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'

function doubaoFlag(name: string) {
  return agentChoiceCliApply(
    'doubao',
    [{ kind: 'value', names: [name], lift: 'separate-and-long-equals' }],
    name
  )
}

const effortApply = doubaoFlag('--effort')

function doubaoEffort(levels: readonly string[], defaultValue = ''): CatalogOption {
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: levels.map((value) => ({ value, label: value })),
      defaultValue
    },
    apply: effortApply
  }
}

export function doubaoCatalogModel(model: CommitMessageModelCapability): CatalogModel {
  const levels = model.thinkingLevels?.map((level) => level.id) ?? []
  return {
    id: model.id,
    label: model.label,
    ...(model.isDefault ? { isDefault: true } : {}),
    declaredDefaultEffort: model.defaultThinkingLevel ?? null,
    options: levels.length ? [doubaoEffort(levels, model.defaultThinkingLevel)] : []
  }
}

export const DOUBAO_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: doubaoFlag('--model'),
  discoveredModelsAreAuthoritative: true,
  defaultModelIsCliDefault: true,
  unknownModelOptions: [doubaoEffort(DOUBAO_EFFORT_LEVELS)],
  listModels: {
    command: 'doubao model list --json',
    parse: (stdout) => parseDoubaoModelList(stdout).map(doubaoCatalogModel)
  }
}
