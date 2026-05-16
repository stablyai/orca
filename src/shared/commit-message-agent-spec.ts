import type { TuiAgent } from './types'

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
  models: CommitMessageModelCapability[]
  defaultModelId: string
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
      ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
    ],
    models: [
      {
        // Why: Haiku 4.5 is a non-reasoning model — `claude --effort` rejects
        // any value for it. Omit thinkingLevels so the UI hides the dropdown
        // and the buildArgs path skips passing --effort entirely.
        id: 'claude-haiku-4-5',
        label: 'Haiku 4.5'
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Sonnet 4.6',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' },
          { id: 'max', label: 'Max' }
        ],
        defaultThinkingLevel: 'low'
      },
      {
        id: 'claude-opus-4-7',
        label: 'Opus 4.7',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' },
          { id: 'max', label: 'Max' }
        ],
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'claude-opus-4-7'
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
      // session or workspace writes. Match T3 Code's safe git-text mode.
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--model',
      model,
      ...(thinkingLevel ? ['-c', `model_reasoning_effort=${thinkingLevel}`] : [])
    ],
    // Why: ordered to match the official `codex` model picker — descending
    // by version so the frontier model lands on top and legacy models trail.
    models: [
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' }
        ],
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' }
        ],
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 Mini',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' }
        ],
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' }
        ],
        defaultThinkingLevel: 'low'
      },
      {
        // Why: Codex's Spark variant accepts `model_reasoning_effort` (the
        // CLI banner reports "reasoning effort: medium" by default); the
        // gating that surfaces "model not supported" is on the account
        // tier, not the effort flag.
        id: 'gpt-5.3-codex-spark',
        label: 'GPT-5.3 Codex Spark',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' }
        ],
        defaultThinkingLevel: 'low'
      },
      {
        id: 'gpt-5.2',
        label: 'GPT-5.2',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' }
        ],
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'gpt-5.5'
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
  return getCommitMessageAgentSpec(agentId)?.models.find((m) => m.id === modelId)
}

function toCommitMessageAgentCapability(
  spec: CommitMessageAgentSpec
): CommitMessageAgentCapability {
  return {
    id: spec.id,
    label: spec.label,
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
