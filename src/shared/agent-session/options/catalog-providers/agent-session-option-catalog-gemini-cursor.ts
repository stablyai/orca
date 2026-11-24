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

// The levels `cursor-agent models` ids can name; a listed model offers its own subset.
const CURSOR_CLI_EFFORTS = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'extra-high', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]
// What `cursor-agent models` ids add after the chat server's id: Claude's `-thinking` (its ids
// without it are non-thinking), effort and Fast.
export const CURSOR_CLI_MODEL_SUFFIX = new RegExp(
  `^(-thinking)?(?:-(${CURSOR_CLI_EFFORTS.map(({ value }) => value).join('|')}))?(-fast)?$`
)

/** Whether an id already names a `cursor-agent models` variant rather than a chat server model. */
function isCursorCliVariant(modelId: string): boolean {
  return [...modelId].some(
    (char, index) => char === '-' && index > 0 && CURSOR_CLI_MODEL_SUFFIX.test(modelId.slice(index))
  )
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

const CURSOR_LISTED_EFFORT: CatalogOption = {
  ...CURSOR_EFFORT,
  kind: { type: 'select', choices: CURSOR_CLI_EFFORTS, defaultValue: '' }
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
  unknownModelOptions: [CURSOR_LISTED_EFFORT, CURSOR_FAST],
  composeModelValue: (modelId, values) => {
    // The chat server's `default` is the CLI's `auto`.
    if (modelId === 'auto' || modelId === 'default') {
      return 'auto'
    }
    if (isCursorCliVariant(modelId)) {
      return modelId
    }
    // The CLI spells the chat server's `extra-high` as `xhigh`.
    const effort =
      typeof values.effort === 'string'
        ? `-${values.effort === 'extra-high' ? 'xhigh' : values.effort}`
        : ''
    const fast = values.fastMode === true ? '-fast' : ''
    // A Claude id without `-thinking` is the non-thinking model; Cursor's Claude models think by default.
    const thinking =
      modelId.startsWith('claude-') &&
      (values.thinking === true || (values.thinking === undefined && (effort || fast)))
        ? '-thinking'
        : ''
    return `${modelId}${thinking}${effort}${fast}`
  },
  listModels: { command: 'cursor-agent models', parse: parseCursorCatalogModels }
}
