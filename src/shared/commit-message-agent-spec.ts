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
    defaultModelId: 'claude-haiku-4-5'
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    promptDelivery: 'argv',
    buildArgs: ({ prompt, model, thinkingLevel }) => [
      'exec',
      '--model',
      model,
      ...(thinkingLevel ? ['-c', `model_reasoning_effort=${thinkingLevel}`] : []),
      prompt
    ],
    // Why: ordered to match the official `codex` model picker — descending
    // by version so the frontier model lands on top and legacy models trail.
    // Default still resolves by id (`gpt-5.4-mini`), independent of order.
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
    defaultModelId: 'gpt-5.4-mini'
  }
}

export const DEFAULT_COMMIT_MESSAGE_AGENT_ID: TuiAgent = 'claude'

export function getCommitMessageAgentSpec(agentId: TuiAgent): CommitMessageAgentSpec | undefined {
  return COMMIT_MESSAGE_AGENT_SPECS[agentId]
}

export function getCommitMessageModel(
  agentId: TuiAgent,
  modelId: string
): CommitMessageModel | undefined {
  return getCommitMessageAgentSpec(agentId)?.models.find((m) => m.id === modelId)
}

/** Ordered list of agents that have a non-interactive mode wired up. */
export function listCommitMessageAgentIds(): TuiAgent[] {
  return Object.keys(COMMIT_MESSAGE_AGENT_SPECS) as TuiAgent[]
}
