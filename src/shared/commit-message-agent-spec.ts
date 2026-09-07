import type { TuiAgent } from './tui-agent'
import { isTuiAgentEnabled } from './tui-agent-selection'
import { labelFromModelId } from './model-id-label'
import { buildPrimaryCommitMessageAgentSpecs } from './commit-message-agent-specs-primary'
import { buildSecondaryCommitMessageAgentSpecs } from './commit-message-agent-specs-secondary'
import {
  BASIC_THINKING_LEVELS,
  CLAUDE_THINKING_LEVELS,
  OPENAI_THINKING_LEVELS,
  parseAntigravityModels,
  parseClaudeModels,
  parseCodexModels,
  parseCursorModels,
  parseLineModels,
  parsePiModels,
  withOpenAiThinking
} from './commit-message-model-parsers'

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
  /** Discovery-provided detail, e.g. what a CLI alias resolves to on this host. */
  description?: string
  /** Omit when the model does not expose an effort selector — the UI then hides the dropdown. */
  thinkingLevels?: ThinkingLevel[]
  /** Required when thinkingLevels is present. */
  defaultThinkingLevel?: string
  /** Whether the model exposes Claude's mid-session Fast mode toggle. */
  supportsFastMode?: boolean
  /** Set when the listing marks this as the id the CLI runs with no --model flag.
   *  Optional so an older remote host that never reports it simply omits it. */
  isDefault?: boolean
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
  /** Alias groups the CLI accepts at most once. Recipe CLI arguments repeating one
   *  replace the generated flag instead of being appended: yargs-based CLIs collapse
   *  a repeated flag into an array and crash. Defaults to the model flag alone. */
  singletonOptions?: readonly (readonly string[])[]
  /** Whether the model list is static or discovered from the agent CLI. */
  modelSource: 'static' | 'dynamic'
  /** Command used by the main process to discover models when modelSource is dynamic. */
  modelDiscovery?: {
    binary: string
    args: string[]
    /** Written to the CLI's stdin, for CLIs whose listing is request-driven. */
    stdinPayload?: string
    parse: (stdout: string) => CommitMessageModel[]
  }
  models: CommitMessageModel[]
  defaultModelId: string
}

export type CommitMessageModelCapability = {
  id: string
  label: string
  description?: string
  thinkingLevels?: ThinkingLevel[]
  defaultThinkingLevel?: string
  supportsFastMode?: boolean
  /** Absent from an older remote host, which simply yields no default to display. */
  isDefault?: boolean
}

export type CommitMessageAgentCapability = {
  id: TuiAgent
  label: string
  modelSource: 'static' | 'dynamic'
  models: CommitMessageModelCapability[]
  defaultModelId: string
}

export const COMMIT_MESSAGE_AGENT_SPECS: Partial<Record<TuiAgent, CommitMessageAgentSpec>> = {
  ...buildPrimaryCommitMessageAgentSpecs({
    CLAUDE_THINKING_LEVELS,
    OPENAI_THINKING_LEVELS,
    parseClaudeModels,
    parseCodexModels,
    parseLineModels,
    parsePiModels,
    withOpenAiThinking
  }),
  ...buildSecondaryCommitMessageAgentSpecs({
    BASIC_THINKING_LEVELS,
    OPENAI_THINKING_LEVELS,
    parseCursorModels,
    parseAntigravityModels
  })
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
  defaultTuiAgent: DefaultTuiAgentPreference,
  disabledTuiAgents?: Iterable<unknown> | null
): CommitMessageAgentChoice | null {
  if (configuredAgentId) {
    return configuredAgentId
  }
  if (
    defaultTuiAgent &&
    defaultTuiAgent !== 'blank' &&
    isTuiAgentEnabled(defaultTuiAgent, disabledTuiAgents)
  ) {
    return getCommitMessageAgentSpec(defaultTuiAgent) ? defaultTuiAgent : null
  }
  return isTuiAgentEnabled(DEFAULT_COMMIT_MESSAGE_AGENT_ID, disabledTuiAgents)
    ? DEFAULT_COMMIT_MESSAGE_AGENT_ID
    : null
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
      ...(model.description ? { description: model.description } : {}),
      ...(model.thinkingLevels ? { thinkingLevels: [...model.thinkingLevels] } : {}),
      ...(model.defaultThinkingLevel ? { defaultThinkingLevel: model.defaultThinkingLevel } : {}),
      ...(model.supportsFastMode ? { supportsFastMode: true } : {})
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
