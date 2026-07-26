import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'

function hasModelFlag(tokens: readonly string[]): boolean {
  return tokens.some(
    (token) =>
      token === '-m' ||
      token === '--model' ||
      token.startsWith('-m=') ||
      (token.startsWith('-m') && !token.startsWith('--')) ||
      token.startsWith('--model=')
  )
}

export const GEMINI_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  models: [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', options: [] },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', options: [] },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', options: [] },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', options: [] }
  ],
  modelApply: {
    launchArgs: (value) => ['-m', String(value)],
    agentArgsOverride: hasModelFlag,
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

function parseCursorModels(stdout: string): CatalogModel[] {
  const seen = new Set<string>()
  const models: CatalogModel[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:[-*]\s+)?([a-z0-9][a-z0-9._-]*)(?:\s+\(.*\))?$/i)
    const id = match?.[1]
    if (!id || id.toLowerCase() === 'models' || seen.has(id)) {
      continue
    }
    seen.add(id)
    models.push({ id, label: id === 'auto' ? 'Auto' : id, options: [] })
  }
  return models
}

export const CURSOR_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
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
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: hasModelFlag,
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
  listModels: { command: 'cursor-agent models', parse: parseCursorModels }
}
