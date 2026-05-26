import type { TuiAgent } from './types'

/* eslint-disable max-lines -- Why: this is the single registry for non-interactive commit-message agents, their model discovery parsers, and UI capabilities. */

// Why: this file is the source of truth for non-interactive agent invocation
// (commit-message generation). It is intentionally separate from
// `tui-agent-config.ts`, which describes interactive PTY launching — mixing
// the two confuses both code paths.

export type ThinkingLevel = { id: string; label: string }

export type CommitMessageModel = {
  /** Value passed to the agent CLI's --model flag. */
  id: string
  /** Visible label in the model dropdown. */
  label: string
  /** Omit when the model does not expose an effort selector — the UI then hides the dropdown. */
  thinkingLevels?: ThinkingLevel[]
  /** Required when thinkingLevels is present. */
  defaultThinkingLevel?: string
}

export type CommitMessageAgentSpec = {
  id: TuiAgent
  /** Visible label in the agent dropdown. */
  label: string
  /** Binary spawned in non-interactive mode. */
  binary: string
  /** Where the prompt is delivered. Large diffs go via stdin to avoid argv limits. */
  promptDelivery: 'argv' | 'stdin'
  buildArgs: (params: { prompt: string; model: string; thinkingLevel?: string }) => string[]
  /** Whether the model list is static or discovered from the agent CLI. */
  modelSource: 'static' | 'dynamic'
  /** Command used by the main process to discover models when modelSource is dynamic. */
  modelDiscovery?: {
    binary: string
    args: string[]
    parse: (stdout: string) => CommitMessageModel[]
  }
  models: CommitMessageModel[]
  defaultModelId: string
}

export type CommitMessageModelCapability = {
  id: string
  label: string
  thinkingLevels?: ThinkingLevel[]
  defaultThinkingLevel?: string
}

export type CommitMessageAgentCapability = {
  id: TuiAgent
  label: string
  modelSource: 'static' | 'dynamic'
  models: CommitMessageModelCapability[]
  defaultModelId: string
}

const BASIC_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }
]

const OPENAI_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' }
]

const CLAUDE_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' }
]

function labelFromModelId(id: string): string {
  return id
    .split(/[/-]/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) {
        return 'GPT'
      }
      return part.length <= 3 && /^\d/.test(part)
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

function uniqueModels(models: CommitMessageModel[]): CommitMessageModel[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) {
      return false
    }
    seen.add(model.id)
    return true
  })
}

function withOpenAiThinking(
  id: string
): Pick<CommitMessageModel, 'thinkingLevels' | 'defaultThinkingLevel'> {
  return /(?:gpt-5|codex)/i.test(id)
    ? { thinkingLevels: OPENAI_THINKING_LEVELS, defaultThinkingLevel: 'low' }
    : {}
}

export function parseCodexModels(stdout: string): CommitMessageModel[] {
  try {
    const parsed = JSON.parse(stdout) as {
      models?: {
        slug?: string
        display_name?: string
        supported_reasoning_levels?: { effort?: string }[]
        default_reasoning_level?: string
      }[]
    }
    return uniqueModels(
      (parsed.models ?? [])
        .filter((model) => model.slug && model.display_name)
        .map((model) => ({
          id: model.slug!,
          label: model.display_name!,
          ...(model.supported_reasoning_levels?.length
            ? {
                thinkingLevels: model.supported_reasoning_levels
                  .map((level) => level.effort)
                  .filter((effort): effort is string => Boolean(effort))
                  .map((effort) => ({
                    id: effort,
                    label: effort === 'xhigh' ? 'Extra High' : labelFromModelId(effort)
                  })),
                defaultThinkingLevel: model.default_reasoning_level ?? 'low'
              }
            : {})
        }))
    )
  } catch {
    return []
  }
}

export function parseLineModels(stdout: string): CommitMessageModel[] {
  return uniqueModels(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.includes(' '))
      .map((id) => ({
        id,
        label: labelFromModelId(id),
        ...withOpenAiThinking(id)
      }))
  )
}

export function parsePiModels(stdout: string): CommitMessageModel[] {
  return uniqueModels(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 6 && parts[0] !== 'provider')
      .map((parts) => {
        const [provider, model, , , thinking] = parts
        const id = `${provider}/${model}`
        return {
          id,
          label: `${labelFromModelId(provider)} ${labelFromModelId(model)}`,
          ...(thinking === 'yes'
            ? {
                thinkingLevels: [
                  { id: 'off', label: 'Off' },
                  { id: 'low', label: 'Low' },
                  { id: 'medium', label: 'Medium' },
                  { id: 'high', label: 'High' },
                  { id: 'xhigh', label: 'Extra High' }
                ],
                defaultThinkingLevel: 'low'
              }
            : {})
        }
      })
  )
}

export function parseCursorModels(stdout: string): CommitMessageModel[] {
  return uniqueModels(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => /^([^\s]+)\s+-\s+(.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => ({
        id: match[1],
        label: match[2].replace(/\s+\((?:default|current)\)$/i, ''),
        ...withOpenAiThinking(match[1])
      }))
  )
}

export const COMMIT_MESSAGE_AGENT_SPECS: Partial<Record<TuiAgent, CommitMessageAgentSpec>> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    binary: 'claude',
    // Why: diffs can be large and `claude -p` reads from stdin natively when no
    // positional prompt is provided.
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      '-p',
      '--output-format',
      'text',
      '--model',
      model,
      '--permission-mode',
      'plan',
      ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
    ],
    modelSource: 'static',
    models: [
      {
        // Why: Claude Code aliases track the account/provider's supported
        // model IDs; hardcoded version IDs can be rejected by Bedrock/Vertex.
        id: 'haiku',
        label: 'Haiku'
      },
      {
        id: 'sonnet',
        label: 'Sonnet',
        thinkingLevels: CLAUDE_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'opus',
        label: 'Opus',
        thinkingLevels: CLAUDE_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'sonnet'
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    // Why: `codex exec` reads stdin when no prompt arg is supplied. Commit
    // prompts include large staged diffs, so argv would exceed Windows and
    // some SSH/POSIX command-line limits.
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      'exec',
      // Why: commit-message generation needs text only, not a persisted agent
      // session or workspace writes. Match the safe git-text mode used by
      // local-first coding agents.
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--model',
      model,
      ...(thinkingLevel ? ['-c', `model_reasoning_effort=${thinkingLevel}`] : [])
    ],
    modelSource: 'dynamic',
    modelDiscovery: {
      binary: 'codex',
      args: ['debug', 'models'],
      parse: parseCodexModels
    },
    // Why: ordered to match the official `codex` model picker — descending
    // by version so the frontier model lands on top and legacy models trail.
    models: [
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        // Why: Codex's Spark variant accepts `model_reasoning_effort` (the
        // CLI banner reports "reasoning effort: medium" by default); the
        // gating that surfaces "model not supported" is on the account
        // tier, not the effort flag.
        id: 'gpt-5.3-codex-spark',
        label: 'GPT-5.3 Codex Spark',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.2',
        label: 'GPT-5.2',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'gpt-5.5'
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    binary: 'opencode',
    promptDelivery: 'argv',
    buildArgs: ({ prompt, model, thinkingLevel }) => [
      'run',
      '--model',
      model,
      '--agent',
      'build',
      '--format',
      'default',
      ...(thinkingLevel ? ['--variant', thinkingLevel] : []),
      prompt
    ],
    modelSource: 'dynamic',
    modelDiscovery: { binary: 'opencode', args: ['models'], parse: parseLineModels },
    models: [
      {
        // Why: OpenCode's hosted GPT models can require workspace billing even
        // when `opencode models` lists them. This free model is available in
        // discovery and works as a usable out-of-the-box default.
        id: 'opencode/deepseek-v4-flash-free',
        label: 'OpenCode DeepSeek V4 Flash Free'
      },
      {
        id: 'opencode/gpt-5.4-mini',
        label: 'OpenCode GPT 5.4 Mini',
        ...withOpenAiThinking('gpt-5.4-mini')
      }
    ],
    defaultModelId: 'opencode/deepseek-v4-flash-free'
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    binary: 'pi',
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      '--print',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-context-files',
      '--mode',
      'text',
      '--model',
      model,
      ...(thinkingLevel ? ['--thinking', thinkingLevel] : [])
    ],
    modelSource: 'dynamic',
    modelDiscovery: { binary: 'pi', args: ['--list-models'], parse: parsePiModels },
    models: [
      {
        // Why: Pi commonly authenticates through GitHub Copilot locally; using
        // that provider avoids selecting a raw OpenAI model when no key exists.
        id: 'github-copilot/gpt-5.4-mini',
        label: 'Github Copilot GPT 5.4 Mini',
        ...withOpenAiThinking('gpt-5.4-mini')
      }
    ],
    defaultModelId: 'github-copilot/gpt-5.4-mini'
  },
  amp: {
    id: 'amp',
    label: 'Amp',
    binary: 'amp',
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      '--execute',
      '--archive',
      '--no-notifications',
      '--no-ide',
      '--no-jetbrains',
      '--mode',
      model,
      ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
    ],
    modelSource: 'static',
    models: [
      { id: 'smart', label: 'Smart' },
      { id: 'rush', label: 'Rush' },
      {
        id: 'large',
        label: 'Large',
        thinkingLevels: BASIC_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'deep',
        label: 'Deep',
        thinkingLevels: BASIC_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'smart'
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    binary: 'cursor-agent',
    promptDelivery: 'argv',
    buildArgs: ({ prompt, model }) => [
      '--print',
      '--mode',
      'ask',
      '--trust',
      '--output-format',
      'text',
      '--model',
      model,
      prompt
    ],
    modelSource: 'dynamic',
    modelDiscovery: { binary: 'cursor-agent', args: ['--list-models'], parse: parseCursorModels },
    models: [{ id: 'auto', label: 'Auto' }],
    defaultModelId: 'auto'
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    binary: 'kimi',
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      '--print',
      '--quiet',
      ...(model && model !== 'default' ? ['--model', model] : []),
      ...(thinkingLevel === 'on'
        ? ['--thinking']
        : thinkingLevel === 'off'
          ? ['--no-thinking']
          : [])
    ],
    modelSource: 'static',
    models: [
      { id: 'default', label: 'Config default' },
      {
        // Why: Kimi resolves its managed model by provider/model; bare model
        // names are rejected by the CLI with "LLM not set".
        id: 'kimi-code/kimi-for-coding',
        label: 'Kimi K2.6',
        thinkingLevels: [
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off' }
        ],
        defaultThinkingLevel: 'on'
      }
    ],
    defaultModelId: 'default'
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot',
    binary: 'copilot',
    promptDelivery: 'argv',
    buildArgs: ({ prompt, model, thinkingLevel }) => [
      '--prompt',
      prompt,
      '--silent',
      '--stream',
      'off',
      '--no-custom-instructions',
      '--model',
      model,
      ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
    ],
    modelSource: 'static',
    // Why: Copilot CLI's picker is policy-filtered per account/org. Keep the
    // full hosted CLI catalog here so users can select models enabled for them.
    models: [
      { id: 'auto', label: 'Auto' },
      {
        id: 'claude-haiku-4.5',
        label: 'Claude Haiku 4.5'
      },
      {
        id: 'claude-sonnet-4.5',
        label: 'Claude Sonnet 4.5'
      },
      {
        id: 'claude-sonnet-4.6',
        label: 'Claude Sonnet 4.6'
      },
      {
        id: 'claude-opus-4.5',
        label: 'Claude Opus 4.5'
      },
      {
        id: 'claude-opus-4.6',
        label: 'Claude Opus 4.6'
      },
      {
        id: 'claude-opus-4.6-fast',
        label: 'Claude Opus 4.6 Fast'
      },
      {
        id: 'claude-opus-4.7',
        label: 'Claude Opus 4.7'
      },
      {
        id: 'gpt-4.1',
        label: 'GPT-4.1'
      },
      {
        id: 'gpt-5-mini',
        label: 'GPT-5 Mini',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.2',
        label: 'GPT-5.2',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.2-codex',
        label: 'GPT-5.2 Codex',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        thinkingLevels: OPENAI_THINKING_LEVELS,
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'gpt-5.4'
  }
}

export const DEFAULT_COMMIT_MESSAGE_AGENT_ID: TuiAgent = 'claude'

// Why: the "custom" choice is not a TuiAgent — it lets the user point Orca
// at any CLI by typing a command template (see customAgentCommand setting +
// planCustomCommand in commit-message-prompt.ts). Keeping it as its own
// sentinel avoids polluting TuiAgent (which is shared with PTY launch /
// new-workspace flows that have nothing to do with this feature).
export const CUSTOM_AGENT_ID = 'custom' as const
export type CustomAgentId = typeof CUSTOM_AGENT_ID
export type CommitMessageAgentChoice = TuiAgent | CustomAgentId
export type DefaultTuiAgentPreference = TuiAgent | 'blank' | null | undefined

export function isCustomAgentId(id: string | null | undefined): id is CustomAgentId {
  return id === CUSTOM_AGENT_ID
}

export function getCommitMessageAgentSpec(agentId: TuiAgent): CommitMessageAgentSpec | undefined {
  return COMMIT_MESSAGE_AGENT_SPECS[agentId]
}

export function resolveCommitMessageAgentChoice(
  configuredAgentId: CommitMessageAgentChoice | null | undefined,
  defaultTuiAgent: DefaultTuiAgentPreference
): CommitMessageAgentChoice | null {
  if (configuredAgentId) {
    return configuredAgentId
  }
  if (defaultTuiAgent && defaultTuiAgent !== 'blank') {
    return getCommitMessageAgentSpec(defaultTuiAgent) ? defaultTuiAgent : null
  }
  return DEFAULT_COMMIT_MESSAGE_AGENT_ID
}

export function getCommitMessageModel(
  agentId: TuiAgent,
  modelId: string
): CommitMessageModel | undefined {
  const spec = getCommitMessageAgentSpec(agentId)
  const model = spec?.models.find((m) => m.id === modelId)
  if (model || !spec || spec.modelSource !== 'dynamic' || modelId.trim().length === 0) {
    return model
  }
  return {
    id: modelId,
    label: labelFromModelId(modelId),
    ...withOpenAiThinking(modelId)
  }
}

function toCommitMessageAgentCapability(
  spec: CommitMessageAgentSpec
): CommitMessageAgentCapability {
  return {
    id: spec.id,
    label: spec.label,
    modelSource: spec.modelSource,
    defaultModelId: spec.defaultModelId,
    // Why: renderer/settings should consume provider capabilities, not the
    // spawn contract. Copy the model metadata so future dynamic probes can
    // swap this source without leaking binary/argv details into UI code.
    models: spec.models.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.thinkingLevels ? { thinkingLevels: [...model.thinkingLevels] } : {}),
      ...(model.defaultThinkingLevel ? { defaultThinkingLevel: model.defaultThinkingLevel } : {})
    }))
  }
}

export function getCommitMessageAgentCapability(
  agentId: TuiAgent
): CommitMessageAgentCapability | undefined {
  const spec = getCommitMessageAgentSpec(agentId)
  return spec ? toCommitMessageAgentCapability(spec) : undefined
}

export function getCommitMessageModelCapability(
  agentId: TuiAgent,
  modelId: string
): CommitMessageModelCapability | undefined {
  return getCommitMessageAgentCapability(agentId)?.models.find((m) => m.id === modelId)
}

/** Ordered list of agents that have a non-interactive mode wired up. */
export function listCommitMessageAgentIds(): TuiAgent[] {
  return Object.keys(COMMIT_MESSAGE_AGENT_SPECS) as TuiAgent[]
}

export function listCommitMessageAgentCapabilities(): CommitMessageAgentCapability[] {
  return listCommitMessageAgentIds()
    .map((id) => getCommitMessageAgentCapability(id))
    .filter((capability): capability is CommitMessageAgentCapability => Boolean(capability))
}
