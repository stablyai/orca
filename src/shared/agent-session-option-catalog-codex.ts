import { hasFlag } from './agent-cli-flag-detection'
import { agentArgOptionTokens, removeAgentArgOption } from './agent-session-option-agent-args'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { CODEX_MODEL_LIST_COMMAND, parseCodexModelList } from './codex-model-list-probe'
import { labelFromModelId } from './model-id-label'

function hasCodexEffortOverride(tokens: readonly string[]): boolean {
  if (hasFlag(tokens, ['--reasoning-effort'])) {
    return true
  }
  const optionTokens = agentArgOptionTokens(tokens)
  return optionTokens.some((token, index) => {
    const previous = optionTokens[index - 1]
    return (
      (token.startsWith('model_reasoning_effort=') &&
        (previous === '-c' || previous === '--config')) ||
      token.startsWith('-cmodel_reasoning_effort=') ||
      token.startsWith('-c=model_reasoning_effort=') ||
      token.startsWith('--config=model_reasoning_effort=')
    )
  })
}

function removeCodexEffortOverride(tokens: readonly string[]): string[] {
  const withoutFlag = removeAgentArgOption(tokens, ['--reasoning-effort'])
  const result: string[] = []
  for (let index = 0; index < withoutFlag.length; index += 1) {
    const token = withoutFlag[index]
    if (token === '--') {
      result.push(...withoutFlag.slice(index))
      break
    }
    const next = withoutFlag[index + 1]
    if ((token === '-c' || token === '--config') && next?.startsWith('model_reasoning_effort=')) {
      index += 1
      continue
    }
    if (
      token.startsWith('-cmodel_reasoning_effort=') ||
      token.startsWith('-c=model_reasoning_effort=') ||
      token.startsWith('--config=model_reasoning_effort=')
    ) {
      continue
    }
    result.push(token)
  }
  return result
}

const CODEX_EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' }
]

function labelCodexEffort(value: string): string {
  return (
    CODEX_EFFORT_CHOICES.find((choice) => choice.value === value)?.label ??
    (value === 'minimal' ? 'Minimal' : labelFromModelId(value))
  )
}

function codexEffortWithChoices(
  choices: readonly { value: string; label: string }[],
  defaultValue: string
): CatalogOption {
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: [...choices],
      defaultValue
    },
    apply: {
      launchArgs: (value) => ['-c', `model_reasoning_effort=${String(value)}`],
      agentArgsOverride: hasCodexEffortOverride,
      removeAgentArgs: removeCodexEffortOverride,
      midSession: { kind: 'agent-picker', command: '/model', delivery: 'type' }
    }
  }
}

// Why: Codex silently clamps a higher requested tier, so expose only advertised levels.
function codexEffort(ceiling: 'xhigh' | 'max' | 'ultra'): CatalogOption {
  const ceilingIndex = CODEX_EFFORT_CHOICES.findIndex((choice) => choice.value === ceiling)
  return codexEffortWithChoices(CODEX_EFFORT_CHOICES.slice(0, ceilingIndex + 1), 'medium')
}

export function createCodexCatalogOptions(args: {
  effortLevelIds: readonly string[]
  defaultEffort?: string
}): CatalogOption[] {
  const seen = new Set<string>()
  const choices = args.effortLevelIds.flatMap((id) => {
    if (!id || seen.has(id)) {
      return []
    }
    seen.add(id)
    return [{ value: id, label: labelCodexEffort(id) }]
  })
  if (choices.length === 0) {
    return []
  }
  const choiceIds = choices.map(({ value }) => value)
  const requestedDefault = args.defaultEffort
  const defaultEffort =
    requestedDefault && choiceIds.includes(requestedDefault)
      ? requestedDefault
      : choiceIds.includes('medium')
        ? 'medium'
        : choices[0].value
  return [codexEffortWithChoices(choices, defaultEffort)]
}

function parseCodexCatalogModels(stdout: string): CatalogModel[] {
  return parseCodexModelList(stdout).flatMap((model) => {
    // Hidden rows are API-only (auto-review, aliases). Picking one is a confusing launch.
    if (model.visibility === 'hide') {
      return []
    }
    return [
      {
        id: model.id,
        label: model.label,
        options: createCodexCatalogOptions({
          effortLevelIds: model.effortLevels,
          ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {})
        })
      }
    ]
  })
}

export const CODEX_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: Codex model access depends on auth. Seed the advertised picker; a successful
  // `codex debug models` probe replaces membership and per-model effort menus.
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', options: [codexEffort('ultra')] },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', options: [codexEffort('ultra')] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', options: [codexEffort('max')] },
    { id: 'gpt-5.5', label: 'GPT-5.5', options: [codexEffort('xhigh')] },
    { id: 'gpt-5.4', label: 'GPT-5.4', options: [codexEffort('xhigh')] },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', options: [codexEffort('xhigh')] },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', options: [codexEffort('xhigh')] }
  ],
  modelApply: {
    launchArgs: (value) => ['-m', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['-m', '--model']),
    // Codex classifies multi-character writes as pasted prose; type the bare
    // command and let its own picker apply the account-supported model.
    midSession: { kind: 'agent-picker', command: '/model', delivery: 'type' }
  },
  unknownModelOptions: [codexEffort('xhigh')],
  // Why: a seeded id the CLI has retired is a fatal `-m`, so a successful probe
  // must drop it. Option menus come from the probe's supported_reasoning_levels.
  discoveredModelsAreAuthoritative: true,
  listModels: {
    command: CODEX_MODEL_LIST_COMMAND,
    parse: parseCodexCatalogModels
  }
}
