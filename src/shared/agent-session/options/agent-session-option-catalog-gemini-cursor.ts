import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { agentChoiceCliApply } from '../../agent-launch/choices/agent-choice-cli-apply'

export const GEMINI_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  models: [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', options: [] },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', options: [] },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', options: [] },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', options: [] }
  ],
  modelApply: {
    ...agentChoiceCliApply(
      'gemini',
      [
        {
          kind: 'value',
          names: ['-m', '--model'],
          lift: 'separate-and-long-equals'
        }
      ],
      '-m'
    ),
    midSession: { kind: 'agent-picker', command: '/model' }
  }
}

const CURSOR_EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

/** Builds a Cursor effort option capped at the model's highest supported tier. */
function cursorEffort(ceiling: 'high' | 'xhigh' | 'max' = 'high'): CatalogOption {
  const ceilingIndex = CURSOR_EFFORT_CHOICES.findIndex((choice) => choice.value === ceiling)
  return {
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: CURSOR_EFFORT_CHOICES.slice(0, ceilingIndex + 1),
      defaultValue: 'high'
    },
    apply: { composedIntoModel: true }
  }
}

const CURSOR_EFFORT = cursorEffort('high')

const CURSOR_FAST: CatalogOption = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', defaultValue: false },
  apply: { composedIntoModel: true }
}

const CURSOR_THINKING: CatalogOption = {
  id: 'thinking',
  label: 'Thinking',
  category: 'model_config',
  kind: { type: 'boolean', defaultValue: true },
  apply: { composedIntoModel: true }
}

/** Parses `cursor-agent models` output rows (`id - Label` or bare IDs) into catalog models. */
function parseCursorModels(stdout: string): CatalogModel[] {
  const seen = new Set<string>()
  const models: CatalogModel[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line
      .trim()
      .match(/^(?:[-*]\s+)?([a-z0-9][a-z0-9._-]*)(?:\s+-\s+(.+?)|\s+\(.*\))?$/i)
    const id = match?.[1]
    if (!id || id.toLowerCase() === 'models' || seen.has(id)) {
      continue
    }
    const rawLabel = match?.[2]
      ?.replace(/\s+\((?:current|default)(?:,\s*(?:current|default))*\)\s*$/i, '')
      .trim()
    seen.add(id)
    models.push({ id, label: rawLabel || (id === 'auto' ? 'Auto' : id), options: [] })
  }
  return models
}

export const CURSOR_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [
    { id: 'auto', label: 'Auto', isDefault: true, options: [] },
    {
      id: 'claude-opus-5-5',
      label: 'Claude Opus 5.5',
      options: [cursorEffort('max'), CURSOR_FAST]
    },
    {
      id: 'claude-sonnet-5-5',
      label: 'Claude Sonnet 5.5',
      options: [cursorEffort('max')]
    },
    {
      id: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      options: [cursorEffort('max'), CURSOR_FAST]
    },
    {
      id: 'gpt-5.3-codex',
      label: 'GPT-5.3 Codex',
      options: [CURSOR_EFFORT, CURSOR_FAST]
    },
    {
      id: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      options: [CURSOR_THINKING, CURSOR_EFFORT]
    }
  ],
  modelApply: {
    ...agentChoiceCliApply(
      'cursor',
      [
        {
          kind: 'value',
          names: ['-m', '--model'],
          lift: 'separate-and-long-equals'
        }
      ],
      '--model'
    ),
    midSession: { kind: 'command', build: (value) => `/model ${String(value)}` }
  },
  /** Composes a Cursor `--model` identifier from the base model ID and selected option suffixes. */
  composeModelValue: (modelId, values) => {
    if (modelId === 'auto') {
      return modelId
    }
    const thinking = modelId.startsWith('claude-') && values.thinking === true ? '-thinking' : ''
    const effort = typeof values.effort === 'string' ? `-${values.effort}` : ''
    const fast = values.fastMode === true ? '-fast' : ''
    return `${modelId}${thinking}${effort}${fast}`
  },
  listModels: { command: 'cursor-agent models', parse: parseCursorModels }
}
