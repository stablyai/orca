import { agentChoiceCliApply } from '../../../agent-launch/choices/agent-choice-cli-apply'
import { AGY_MODEL_LIST_ARGS, parseAgyModelRows } from '../model-catalog/agy-model-list-probe'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'

/** agy lists each level of a model family as "<family>-<level>", e.g. gemini-3.8-flash-low. */
export const ANTIGRAVITY_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const

export const ANTIGRAVITY_LEVEL_SUFFIX = new RegExp(
  `^(.+)-(${ANTIGRAVITY_EFFORT_LEVELS.join('|')})$`
)

function composeAntigravityLaunchModel(modelId: string, effort: unknown): string {
  const match = ANTIGRAVITY_LEVEL_SUFFIX.exec(modelId)
  const level = ANTIGRAVITY_EFFORT_LEVELS.find((value) => value === effort)
  return match && level ? `${match[1]}-${level}` : modelId
}

const ANTIGRAVITY_EFFORT_CLI = agentChoiceCliApply(
  'antigravity',
  [{ kind: 'value', names: ['--effort'], lift: 'separate-and-long-equals' }],
  '--effort'
)

const ANTIGRAVITY_EFFORT: CatalogOption & {
  kind: Extract<CatalogOption['kind'], { type: 'select' }>
} = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' }
    ],
    defaultValue: 'high'
  },
  apply: {
    ...ANTIGRAVITY_EFFORT_CLI,
    // A leveled --model already carries effort; both flags can run the wrong model (#39556).
    launchArgs: (value, trailing, launchModelId) =>
      launchModelId && ANTIGRAVITY_LEVEL_SUFFIX.test(launchModelId)
        ? []
        : (ANTIGRAVITY_EFFORT_CLI.launchArgs?.(value, trailing) ?? []),
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

export function antigravityCatalogModels(
  rows: readonly Pick<CatalogModel, 'id' | 'label'>[]
): CatalogModel[] {
  const ids = new Set(rows.map(({ id }) => id))
  return rows.map(({ id, label }) => {
    const [, family, level] = ANTIGRAVITY_LEVEL_SUFFIX.exec(id) ?? []
    const effort = family
      ? {
          ...ANTIGRAVITY_EFFORT,
          kind: {
            ...ANTIGRAVITY_EFFORT.kind,
            choices: ANTIGRAVITY_EFFORT.kind.choices.filter(({ value }) =>
              ids.has(`${family}-${value}`)
            ),
            defaultValue: level,
            defaultIsCliDefault: true as const
          }
        }
      : ANTIGRAVITY_EFFORT
    return { id, label, options: [effort] }
  })
}

export const ANTIGRAVITY_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Model availability is account-scoped; worker-start accepts the slug reported by `agy models`.
  models: [],
  modelApply: {
    ...agentChoiceCliApply(
      'antigravity',
      [
        {
          kind: 'value',
          names: ['--model'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--model'
    ),
    midSession: { kind: 'agent-picker', command: '/model' }
  },
  discoveredModelsAreAuthoritative: true,
  listModels: {
    command: `agy ${AGY_MODEL_LIST_ARGS.join(' ')}`,
    parse: (stdout) => antigravityCatalogModels(parseAgyModelRows(stdout))
  },
  unknownModelOptions: [ANTIGRAVITY_EFFORT],
  composeModelValue: (modelId, values) => composeAntigravityLaunchModel(modelId, values.effort)
}
