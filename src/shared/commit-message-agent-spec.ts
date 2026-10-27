import { OMP_MODEL_LIST_ARGS, parseOmpModelList } from './omp-model-list-probe'
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

// Keep noninteractive generation separate from tui-agent-config’s interactive PTY launch contract.

export type ThinkingLevel = { id: string; label: string }

export type CommitMessageModel = {
  id: string
  label: string
  /** Discovery-provided detail, e.g. what a CLI alias resolves to on this host. */
  description?: string
  /** Omit when the model does not expose an effort selector — the UI then hides the dropdown. */
  thinkingLevels?: ThinkingLevel[]
  /** Required when thinkingLevels is present. */
  defaultThinkingLevel?: string
  /** Whether the model exposes Claude's mid-session Fast mode toggle. */
  supportsFastMode?: boolean
  /** Whether Claude's listing says the model runs its auto permission mode; absent is unknown. */
  supportsAutoMode?: boolean
  /** CLI default model ID; older remote hosts may omit this discovery field. */
  isDefault?: boolean
  /** Tokens the model's context window holds, where the listing states it. */
  contextWindowTokens?: number
}

export type CommitMessageAgentSpec = {
  id: TuiAgent
  label: string
  binary: string
  /** Where the prompt is delivered. Large diffs go via stdin to avoid argv limits. */
  promptDelivery: 'argv' | 'stdin'
  buildArgs: (params: {
    prompt: string
    model: string
    thinkingLevel?: string
    strictMcp?: boolean
    userArgs?: readonly string[]
  }) => string[]
  /** User recipe args replace generated singleton alias groups; repeats make yargs parse arrays and crash. Default: model flag only. */
  singletonOptions?: readonly (readonly string[])[]
  modelSource: 'static' | 'dynamic'
  /** Discover models on main for dynamic sources. */
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
  /** Absent from an older remote host; readers then treat the window as unknown. */
  contextWindowTokens?: number
}

export type CommitMessageAgentCapability = {
  id: TuiAgent
  label: string
  modelSource: 'static' | 'dynamic'
  models: CommitMessageModelCapability[]
  defaultModelId: string
}

export const COMMIT_MESSAGE_AGENT_SPECS: Partial<Record<TuiAgent, CommitMessageAgentSpec>> = {
  omp: {
    id: 'omp',
    label: 'OMP',
    binary: 'omp',
    promptDelivery: 'stdin',
    buildArgs: ({ model, thinkingLevel }) => [
      '--print',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--mode',
      'text',
      ...(model && model !== 'default' ? ['--model', model] : []),
      ...(thinkingLevel ? ['--thinking', thinkingLevel] : [])
    ],
    singletonOptions: [['--model'], ['--thinking']],
    modelSource: 'dynamic',
    modelDiscovery: { binary: 'omp', args: OMP_MODEL_LIST_ARGS, parse: parseOmpModelList },
    models: [{ id: 'default', label: 'Config default' }],
    defaultModelId: 'default'
  },
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
    parseAntigravityModels,
    parseLineModels
  })
}

export const DEFAULT_COMMIT_MESSAGE_AGENT_ID: TuiAgent = 'claude'

// Keep custom-command sentinel separate from TuiAgent, whose PTY/workspace flows do not accept user templates.
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
    // Expose copied model capabilities to UI/settings without coupling them to spawn binary/argv or future discovery sources.
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

/** Ordered list of agents that have a non-interactive mode wired up. */
export function listCommitMessageAgentIds(): TuiAgent[] {
  return Object.keys(COMMIT_MESSAGE_AGENT_SPECS) as TuiAgent[]
}

export function listCommitMessageAgentCapabilities(): CommitMessageAgentCapability[] {
  return listCommitMessageAgentIds()
    .map((id) => getCommitMessageAgentCapability(id))
    .filter((capability): capability is CommitMessageAgentCapability => Boolean(capability))
}
