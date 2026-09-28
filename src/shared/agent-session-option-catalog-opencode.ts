import { hasFlag } from './agent-cli-flag-detection'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'

const OPENCODE_EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

function opencodeEffort(): CatalogOption {
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: OPENCODE_EFFORT_CHOICES,
      defaultValue: 'medium'
    },
    apply: {
      launchArgs: (value) => ['--thinking', String(value)],
      agentArgsOverride: (tokens) => hasFlag(tokens, ['--thinking']),
      midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
    }
  }
}

const OPENCODE_MODELS: CatalogModel[] = [
  {
    id: 'kr/claude-opus-4.7',
    label: 'Claude Opus 4.7',
    description: 'Most capable for complex tasks',
    isDefault: true,
    options: [opencodeEffort()]
  },
  {
    id: 'kr/claude-sonnet-4.5',
    label: 'Claude Sonnet 4.5',
    description: 'Balanced for everyday tasks',
    options: [opencodeEffort()]
  },
  {
    id: 'kr/claude-sonnet-4.5-thinking-agentic',
    label: 'Claude Sonnet 4.5 Thinking',
    description: 'Extended thinking for complex reasoning',
    options: [opencodeEffort()]
  },
  {
    id: 'kr/claude-sonnet-4.5-agentic',
    label: 'Claude Sonnet 4.5 Agentic',
    description: 'Optimized for agent workflows',
    options: [opencodeEffort()]
  },
  {
    id: 'kr/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    description: 'Fastest for quick answers',
    options: []
  },
  {
    id: 'kr/claude-haiku-4.5-thinking',
    label: 'Claude Haiku 4.5 Thinking',
    description: 'Fast with extended thinking',
    options: [opencodeEffort()]
  },
  {
    id: 'kr/claude-haiku-4.5-thinking-agentic',
    label: 'Claude Haiku 4.5 Thinking Agentic',
    description: 'Fast thinking for agent workflows',
    options: [opencodeEffort()]
  },
  {
    id: 'kr/claude-haiku-4.5-agentic',
    label: 'Claude Haiku 4.5 Agentic',
    description: 'Fast agentic tasks',
    options: []
  }
]

export const OPENCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: OPENCODE_MODELS,
  modelApply: {
    launchArgs: (value) => ['-m', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    midSession: { kind: 'command', build: (value) => `/model ${String(value)}` }
  },
  unknownModelOptions: [opencodeEffort()]
}
