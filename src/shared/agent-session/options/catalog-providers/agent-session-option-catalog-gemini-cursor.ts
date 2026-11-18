import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { agentChoiceCliApply } from '../../../agent-launch/choices/agent-choice-cli-apply'
import { parseCursorModels } from '../../../source-control/ai/generation/commit-message-model-parsers'

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

const CURSOR_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ],
    defaultValue: 'high'
  },
  apply: { composedIntoModel: true }
}

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

function parseCursorCatalogModels(stdout: string): CatalogModel[] {
  return parseCursorModels(stdout).map(({ id, label, isDefault }) => ({
    id,
    label,
    ...(isDefault ? { isDefault } : {}),
    options: []
  }))
}

export const CURSOR_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [
    { id: 'auto', label: 'Auto', isDefault: true, options: [] },
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
  composeModelValue: (modelId, values) => {
    if (modelId === 'auto') {
      return modelId
    }
    if (modelId.startsWith('claude-')) {
      const thinking = values.thinking === true ? '-thinking' : ''
      const effort = typeof values.effort === 'string' ? `-${values.effort}` : ''
      return `${modelId}${thinking}${effort}`
    }
    const effort = typeof values.effort === 'string' ? `-${values.effort}` : ''
    const fast = values.fastMode === true ? '-fast' : ''
    return `${modelId}${effort}${fast}`
  },
  listModels: { command: 'cursor-agent models', parse: parseCursorCatalogModels }
}
