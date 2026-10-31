import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { agentChoiceCliApply } from './agent-choice-cli-apply'
import {
  CLAUDE_MODEL_LIST_ARGS,
  CLAUDE_MODEL_LIST_STDIN,
  parseClaudeModelList
} from './claude-model-list-probe'

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
      ...agentChoiceCliApply(
        'claude',
        [
          {
            kind: 'value',
            names: ['--effort'],
            lift: 'separate-and-long-equals'
          }
        ],
        '--effort'
      ),
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
  apply: {
    ...agentChoiceCliApply(
      'claude',
      [{ kind: 'settings', names: ['--settings'], key: 'fastMode', lift: 'merged-json' }],
      '--settings'
    ),
    midSession: { kind: 'toggle-command', command: '/fast' }
  }
}

export const CLAUDE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Use CLI family aliases/labels across versions; pinned names mislabel older hosts and break header/model-echo matching. listModels supplies exact host names.
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
    ...agentChoiceCliApply(
      'claude',
      [
        {
          kind: 'value',
          names: ['--model'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--model'
    ),
    midSession: {
      kind: 'command',
      build: (value) => `/model ${String(value)}`,
      pickerCommand: '/model',
      // Detect the actual cached-history confirmation prompt so ordinary model changes stay in native chat.
      detectAgentInteraction: 'claude-model-switch-confirmation'
    }
  },
  unknownModelOptions: [claudeEffort(true), CLAUDE_FAST_MODE],
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
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' }
]

// Why: Codex can clamp higher values, so expose only each model's advertised levels.
function codexEffort(ceiling: 'xhigh' | 'max' | 'ultra'): CatalogOption {
  const ceilingIndex = CODEX_EFFORT_CHOICES.findIndex((choice) => choice.value === ceiling)
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: CODEX_EFFORT_CHOICES.slice(0, ceilingIndex + 1),
      defaultValue: 'medium'
    },
    apply: {
      ...agentChoiceCliApply(
        'codex',
        [
          {
            kind: 'config',
            names: ['-c', '--config'],
            key: 'model_reasoning_effort',
            lift: 'codex-bare-string'
          },
          { kind: 'value', names: ['--reasoning-effort'], lift: 'never' }
        ],
        '-c'
      ),
      midSession: { kind: 'agent-picker', command: '/model', delivery: 'type' }
    }
  }
}

const CODEX_SERVICE_TIER: CatalogOption = {
  id: 'serviceTier',
  label: 'Speed',
  category: 'mode',
  kind: { type: 'select', choices: [], defaultValue: 'default' },
  apply: agentChoiceCliApply(
    'codex',
    [{ kind: 'config', names: ['-c', '--config'], key: 'service_tier', lift: 'codex-bare-string' }],
    '-c'
  )
}

export const CODEX_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  hostListingNamesConfiguredModel: true,
  // Auth scopes Codex access; keep a short seed and admit unknown persisted IDs.
  models: [
    {
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      options: [codexEffort('ultra')]
    },
    {
      id: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      options: [codexEffort('ultra')]
    },
    {
      id: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      options: [codexEffort('max')]
    },
    { id: 'gpt-5.5', label: 'GPT-5.5', options: [codexEffort('xhigh')] },
    {
      id: 'gpt-5.2-codex',
      label: 'GPT-5.2 Codex',
      options: [codexEffort('xhigh')]
    }
  ],
  modelApply: {
    ...agentChoiceCliApply(
      'codex',
      [
        {
          kind: 'value',
          names: ['-m', '--model'],
          lift: 'separate-and-long-equals'
        },
        { kind: 'config', names: ['-c', '--config'], key: 'model', lift: 'codex-bare-string' }
      ],
      '-m'
    ),
    // Codex treats multi-character writes as paste; type the command and let its picker select an account-supported model.
    midSession: { kind: 'agent-picker', command: '/model', delivery: 'type' }
  },
  // New models may support max/ultra; unsupported efforts fall back to the model default instead of failing.
  unknownModelOptions: [codexEffort('ultra'), CODEX_SERVICE_TIER]
}
