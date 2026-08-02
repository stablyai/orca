import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

function hasFlag(tokens: readonly string[], flags: readonly string[]): boolean {
  return tokens.some((token) =>
    flags.some(
      (flag) =>
        token === flag ||
        token.startsWith(`${flag}=`) ||
        (flag.startsWith('-') && !flag.startsWith('--') && token.startsWith(flag))
    )
  )
}

function hasCodexEffortOverride(tokens: readonly string[]): boolean {
  if (hasFlag(tokens, ['--reasoning-effort'])) {
    return true
  }
  return tokens.some((token, index) => {
    const previous = tokens[index - 1]
    return (
      (token.startsWith('model_reasoning_effort=') &&
        (previous === '-c' || previous === '--config')) ||
      token.startsWith('-cmodel_reasoning_effort=') ||
      token.startsWith('-c=model_reasoning_effort=') ||
      token.startsWith('--config=model_reasoning_effort=')
    )
  })
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
  return {
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: extended ? EXTENDED_EFFORT_CHOICES : STANDARD_EFFORT_CHOICES,
      defaultValue: 'high'
    },
    apply: {
      launchArgs: (value) => ['--effort', String(value)],
      agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort']),
      midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
    }
  }
}

const CLAUDE_FAST_MODE: CatalogOption = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', defaultValue: false },
  apply: { midSession: { kind: 'toggle-command', command: '/fast' } }
}

export const CLAUDE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  models: [
    {
      id: 'fable',
      label: 'Fable 5',
      options: [claudeEffort(true)]
    },
    {
      id: 'opus',
      label: 'Opus 4.8',
      options: [claudeEffort(true), CLAUDE_FAST_MODE]
    },
    {
      id: 'sonnet',
      label: 'Sonnet 5',
      isDefault: true,
      options: [claudeEffort(true)]
    },
    {
      id: 'haiku',
      label: 'Haiku',
      options: []
    }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    midSession: {
      kind: 'command',
      build: (value) => `/model ${String(value)}`,
      pickerCommand: '/model',
      // Why: Claude sometimes confirms a cached-history switch. Detect the
      // actual prompt so ordinary model changes stay in native chat.
      detectAgentInteraction: 'claude-model-switch-confirmation'
    }
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
      midSession: { kind: 'agent-picker', command: '/model' }
    }
  }
}

export const CODEX_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
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
    midSession: { kind: 'agent-picker', command: '/model' }
  }
}
