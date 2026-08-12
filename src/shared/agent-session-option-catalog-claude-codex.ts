import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { agentArgOptionTokens, removeAgentArgOption } from './agent-session-option-agent-args'
import {
  CLAUDE_MODEL_LIST_ARGS,
  CLAUDE_MODEL_LIST_STDIN,
  parseClaudeModelList
} from './claude-model-list-probe'
import { hasFlag } from './agent-cli-flag-detection'

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

const STANDARD_EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

const EXTENDED_EFFORT_CHOICES = [
  ...STANDARD_EFFORT_CHOICES,
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

function claudeEffort(extended: boolean): CatalogOption {
  return claudeEffortWithChoices(extended ? EXTENDED_EFFORT_CHOICES : STANDARD_EFFORT_CHOICES)
}

function claudeEffortWithChoices(choices: typeof EXTENDED_EFFORT_CHOICES): CatalogOption {
  return {
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices,
      defaultValue: choices.some((choice) => choice.value === 'high')
        ? 'high'
        : (choices[0]?.value ?? 'high')
    },
    apply: {
      launchArgs: (value) => ['--effort', String(value)],
      agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort']),
      removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--effort']),
      midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
    }
  }
}

export function createClaudeCatalogOptions(args: {
  effortLevelIds: readonly string[]
  supportsFastMode?: boolean
}): CatalogOption[] {
  const effortChoices = EXTENDED_EFFORT_CHOICES.filter((choice) =>
    args.effortLevelIds.includes(choice.value)
  )
  return [
    ...(effortChoices.length > 0 ? [claudeEffortWithChoices(effortChoices)] : []),
    ...(args.supportsFastMode ? [CLAUDE_FAST_MODE] : [])
  ]
}

function parseClaudeCatalogModels(stdout: string): CatalogModel[] {
  return parseClaudeModelList(stdout).map((model) => {
    return {
      id: model.id,
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
      options: createClaudeCatalogOptions({
        effortLevelIds: model.effortLevels,
        supportsFastMode: model.supportsFastMode
      })
    }
  })
}

const CLAUDE_FAST_MODE: CatalogOption = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', defaultValue: false },
  apply: { midSession: { kind: 'toggle-command', command: '/fast' } }
}

export const CLAUDE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: these ids are Claude CLI aliases that resolve to the newest model of
  // each family on the host's CLI (`opus` is Opus 5 on current CLIs, older
  // Opus on older CLIs), so pinned version labels lie on part of the fleet.
  // Family labels also keep header scraping and /model echo detection working
  // across CLI versions; listModels overlays exact per-host names below.
  models: [
    {
      id: 'fable',
      label: 'Fable',
      description: 'Most capable for the hardest, longest-running tasks',
      options: [claudeEffort(true)]
    },
    {
      id: 'opus',
      label: 'Opus',
      description: 'Best for everyday, complex tasks',
      options: [claudeEffort(true), CLAUDE_FAST_MODE]
    },
    {
      id: 'sonnet',
      label: 'Sonnet',
      description: 'Efficient for routine tasks',
      isDefault: true,
      options: [claudeEffort(true)]
    },
    {
      id: 'haiku',
      label: 'Haiku',
      description: 'Fastest for quick answers',
      options: []
    }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model']),
    midSession: {
      kind: 'command',
      build: (value) => `/model ${String(value)}`,
      pickerCommand: '/model',
      // Why: Claude sometimes confirms a cached-history switch. Detect the
      // actual prompt so ordinary model changes stay in native chat.
      detectAgentInteraction: 'claude-model-switch-confirmation'
    }
  },
  unknownModelOptions: [claudeEffort(true)],
  listModels: {
    command: `echo '${CLAUDE_MODEL_LIST_STDIN.trim()}' | claude ${CLAUDE_MODEL_LIST_ARGS.join(' ')}`,
    parse: parseClaudeCatalogModels
  }
}

const CODEX_EFFORT_CHOICES = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' }
]

function codexEffort(includeExtraHigh: boolean): CatalogOption {
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: includeExtraHigh
        ? CODEX_EFFORT_CHOICES
        : CODEX_EFFORT_CHOICES.filter((choice) => choice.value !== 'xhigh'),
      defaultValue: 'medium'
    },
    apply: {
      launchArgs: (value) => ['-c', `model_reasoning_effort=${String(value)}`],
      agentArgsOverride: hasCodexEffortOverride,
      removeAgentArgs: removeCodexEffortOverride,
      midSession: { kind: 'agent-picker', command: '/model', delivery: 'type' }
    }
  }
}

export const CODEX_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: Codex model access depends on auth. Keep this seed short and allow
  // unknown persisted ids to pass through instead of claiming a complete list.
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', options: [codexEffort(true)] },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', options: [codexEffort(true)] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', options: [codexEffort(false)] },
    { id: 'gpt-5.5', label: 'GPT-5.5', options: [codexEffort(true)] },
    {
      id: 'gpt-5.2-codex',
      label: 'GPT-5.2 Codex',
      options: [codexEffort(true)]
    }
  ],
  modelApply: {
    launchArgs: (value) => ['-m', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['-m', '--model']),
    // Codex classifies multi-character writes as pasted prose; type the bare
    // command and let its own picker apply the account-supported model.
    midSession: { kind: 'agent-picker', command: '/model', delivery: 'type' }
  },
  unknownModelOptions: [codexEffort(true)]
}
