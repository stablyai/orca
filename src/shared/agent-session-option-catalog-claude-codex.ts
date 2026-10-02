import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import {
  CLAUDE_MODEL_LIST_ARGS,
  CLAUDE_MODEL_LIST_STDIN,
  parseClaudeModelList
} from './claude-model-list-probe'
import { hasFlag } from './agent-cli-flag-detection'
import {
  hasCodexConfigOverride,
  hasCodexEffortOverride,
  removeCodexConfigOverride,
  removeCodexEffortOverride
} from './codex-config-args'

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
  supportsContextWindow?: boolean
}): CatalogOption[] {
  const effortChoices = EXTENDED_EFFORT_CHOICES.filter((choice) =>
    args.effortLevelIds.includes(choice.value)
  )
  return [
    ...(effortChoices.length > 0 ? [claudeEffortWithChoices(effortChoices)] : []),
    ...(args.supportsContextWindow ? [CLAUDE_CONTEXT_WINDOW] : []),
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
        supportsFastMode: model.supportsFastMode,
        supportsContextWindow: claudeModelSupportsContextWindow(model.id)
      })
    }
  })
}

const CLAUDE_FAST_MODE: CatalogOption = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', defaultValue: false },
  apply: {
    midSession: {
      kind: 'command',
      build: (value) => `/fast ${value === true ? 'on' : 'off'}`,
      pickerCommand: '/fast'
    }
  }
}

const CODEX_FAST_MODE: CatalogOption = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  launchDefault: false,
  kind: { type: 'boolean', defaultValue: false },
  apply: {
    launchArgs: (value) => ['-c', `service_tier=${value === true ? '"priority"' : '"default"'}`],
    agentArgsOverride: (tokens) => hasCodexConfigOverride(tokens, 'service_tier'),
    removeAgentArgs: (tokens) => removeCodexConfigOverride(tokens, 'service_tier'),
    midSession: { kind: 'toggle-command', command: '/fast' }
  }
}

const CLAUDE_CONTEXT_WINDOW: CatalogOption = {
  id: 'contextWindow',
  label: 'Context window',
  category: 'model_config',
  kind: {
    type: 'select',
    choices: [
      { value: 'standard', label: 'Standard (200k)' },
      { value: '1m', label: '1M' }
    ],
    defaultValue: 'standard'
  },
  apply: { composedIntoModel: true }
}

const CLAUDE_LATEST_MODEL_ALIASES: Record<string, string> = {
  'claude-fable-5': 'fable',
  'fable 5': 'fable',
  'claude-opus-5': 'opus',
  'opus 5': 'opus',
  'claude-sonnet-5': 'sonnet',
  'sonnet 5': 'sonnet'
}

export function normalizeClaudeModelId(value: string): string {
  const model = value.trim().replace(/\[1m\]$/i, '')
  return CLAUDE_LATEST_MODEL_ALIASES[model.toLowerCase()] ?? model
}

// The 1M context window ships on the Fable/Opus/Sonnet families only.
export function claudeModelSupportsContextWindow(modelId: string): boolean {
  const model = normalizeClaudeModelId(modelId)
  return (
    model === 'fable' ||
    model === 'opus' ||
    model === 'sonnet' ||
    /^claude-(?:fable|opus|sonnet)-/i.test(model)
  )
}

export function normalizeClaudeSessionOptionValues(
  values: Record<string, string | boolean>
): Record<string, string | boolean> {
  if (typeof values.model !== 'string') {
    return values
  }
  const rawModel = values.model.trim()
  const model = normalizeClaudeModelId(rawModel)
  return {
    ...values,
    model,
    ...(claudeModelSupportsContextWindow(model) && values.contextWindow === undefined
      ? { contextWindow: /\[1m\]$/i.test(rawModel) ? '1m' : 'standard' }
      : {})
  }
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
      options: [claudeEffort(true), CLAUDE_CONTEXT_WINDOW]
    },
    {
      id: 'opus',
      label: 'Opus',
      description: 'Best for everyday, complex tasks',
      options: [claudeEffort(true), CLAUDE_CONTEXT_WINDOW, CLAUDE_FAST_MODE]
    },
    {
      id: 'sonnet',
      label: 'Sonnet',
      description: 'Efficient for routine tasks',
      isDefault: true,
      options: [claudeEffort(true), CLAUDE_CONTEXT_WINDOW]
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
  },
  composeModelValue: (modelId, values) =>
    values.contextWindow === '1m' ? `${modelId}[1m]` : modelId
}

const CODEX_EFFORT_CHOICES = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' }
]

export function codexEffortFromChoices(
  choices = CODEX_EFFORT_CHOICES,
  defaultValue = 'medium'
): CatalogOption {
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices,
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

export function createCodexCatalogOptions(args: {
  effortChoices: { value: string; label: string }[]
  defaultEffort?: string
  supportsFastMode?: boolean
}): CatalogOption[] {
  return [
    ...(args.effortChoices.length > 0
      ? [codexEffortFromChoices(args.effortChoices, args.defaultEffort)]
      : []),
    ...(args.supportsFastMode ? [CODEX_FAST_MODE] : [])
  ]
}

// Why: Codex can clamp higher values, so expose only each model's advertised levels.
function codexEffort(ceiling: 'xhigh' | 'max' | 'ultra'): CatalogOption {
  const ceilingIndex = CODEX_EFFORT_CHOICES.findIndex((choice) => choice.value === ceiling)
  return codexEffortFromChoices(CODEX_EFFORT_CHOICES.slice(0, ceilingIndex + 1))
}

export const CODEX_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: codex model/effort are pure CLI flags that die with the process; they
  // must be embedded in every cold-restore launch command.
  capturesOptionsInLaunchCommand: true,
  // Why: Codex model access depends on auth. Keep this seed short and allow
  // unknown persisted ids to pass through instead of claiming a complete list.
  models: [
    {
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      options: [codexEffort('ultra'), CODEX_FAST_MODE]
    },
    {
      id: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      options: [codexEffort('ultra'), CODEX_FAST_MODE]
    },
    {
      id: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      options: [codexEffort('max'), CODEX_FAST_MODE]
    },
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      options: [codexEffort('xhigh'), CODEX_FAST_MODE]
    },
    {
      id: 'gpt-5.2-codex',
      label: 'GPT-5.2 Codex',
      options: [codexEffort('xhigh'), CODEX_FAST_MODE]
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
  unknownModelOptions: [codexEffort('xhigh'), CODEX_FAST_MODE]
}
