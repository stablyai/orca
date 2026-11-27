import { isGlobalAiTextAction } from '../recipes/source-control-ai-actions'
import type {
  CommitMessageAiSettings,
  CommitMessageAiModelCapability
} from '../generation/commit-message-ai-types'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../generation/commit-message-host-key'
import { getCommitMessageAgentSpec } from '../generation/commit-message-agent-spec'
import type { TuiAgent } from '../../../agent-launch/catalog/tui-agent'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiModelChoice,
  AiTextOperation,
  SourceControlAiSettings
} from './source-control-ai-settings-types'

export function readSourceControlAiModelChoiceForHost(
  choice: SourceControlAiModelChoice | null | undefined,
  hostKey: string,
  agentId: TuiAgent
): string | undefined {
  return (
    choice?.selectedModelByAgentByHost?.[hostKey]?.[agentId] ??
    (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
      ? choice?.selectedModelByAgent?.[agentId]
      : undefined)
  )
}

export function selectSourceControlAiModelChoiceForHost(
  choice: SourceControlAiModelChoice | undefined,
  hostKey: string,
  agentId: TuiAgent,
  modelId: string
): SourceControlAiModelChoice {
  return {
    ...choice,
    selectedModelByAgent:
      hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
        ? { ...choice?.selectedModelByAgent, [agentId]: modelId }
        : choice?.selectedModelByAgent,
    selectedModelByAgentByHost: {
      ...choice?.selectedModelByAgentByHost,
      [hostKey]: {
        ...choice?.selectedModelByAgentByHost?.[hostKey],
        [agentId]: modelId
      }
    }
  }
}

export function clearSourceControlAiModelChoiceForHost(
  choice: SourceControlAiModelChoice | undefined,
  hostKey: string,
  agentId: TuiAgent
): SourceControlAiModelChoice | undefined {
  if (!choice) {
    return undefined
  }
  const selectedModelByAgent = { ...choice.selectedModelByAgent }
  if (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY) {
    delete selectedModelByAgent[agentId]
  }
  const selectedModelByAgentByHost = { ...choice.selectedModelByAgentByHost }
  const hostModels = { ...selectedModelByAgentByHost[hostKey] }
  delete hostModels[agentId]
  if (Object.keys(hostModels).length > 0) {
    selectedModelByAgentByHost[hostKey] = hostModels
  } else {
    delete selectedModelByAgentByHost[hostKey]
  }
  const nextChoice: SourceControlAiModelChoice = {}
  if (Object.keys(selectedModelByAgent).length > 0) {
    nextChoice.selectedModelByAgent = selectedModelByAgent
  }
  if (Object.keys(selectedModelByAgentByHost).length > 0) {
    nextChoice.selectedModelByAgentByHost = selectedModelByAgentByHost
  }
  const hasModelSelection =
    nextChoice.selectedModelByAgent !== undefined ||
    nextChoice.selectedModelByAgentByHost !== undefined
  if (hasModelSelection && Object.keys(choice.selectedThinkingByModel ?? {}).length > 0) {
    nextChoice.selectedThinkingByModel = choice.selectedThinkingByModel
  }
  return hasModelSelection ? nextChoice : undefined
}

export function mergeSelectedModelByAgentByHost(
  base: Partial<Record<string, Partial<Record<TuiAgent, string>>>> | undefined,
  override: Partial<Record<string, Partial<Record<TuiAgent, string>>>> | undefined
): Partial<Record<string, Partial<Record<TuiAgent, string>>>> {
  const merged = base === undefined ? {} : structuredClone(base)
  for (const [hostKey, hostModels] of Object.entries(override ?? {})) {
    merged[hostKey] = { ...merged[hostKey], ...hostModels }
  }
  return merged
}

export function getDiscoveredModels(
  source: SourceControlAiSettings,
  legacy: CommitMessageAiSettings | null | undefined,
  hostKey: string,
  agentId: TuiAgent
): CommitMessageAiModelCapability[] {
  return (
    source.discoveredModelsByAgentByHost?.[hostKey]?.[agentId] ??
    (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
      ? (source.discoveredModelsByAgent?.[agentId] ??
        legacy?.discoveredModelsByAgentByHost?.[hostKey]?.[agentId] ??
        legacy?.discoveredModelsByAgent?.[agentId] ??
        [])
      : (legacy?.discoveredModelsByAgentByHost?.[hostKey]?.[agentId] ?? []))
  )
}

/** Discovered models as settings keep them: an alias row's resolved model is read live, never saved. */
export function savedDiscoveredModels(
  models: readonly (CommitMessageAiModelCapability & { resolvedModel?: string })[]
): CommitMessageAiModelCapability[] {
  return models.map(({ resolvedModel: _resolvedModel, ...model }) => model)
}

/** Save a host's discovered models where generation, and older builds, read them. */
export function withDiscoveredModels(
  config: SourceControlAiSettings,
  agentId: TuiAgent,
  discovered: CommitMessageAiModelCapability[],
  hostKey: string,
  listedAt = Date.now()
): Pick<
  SourceControlAiSettings,
  'discoveredModelsByAgent' | 'discoveredModelsByAgentByHost' | 'discoveredAtByAgentByHost'
> {
  const models = savedDiscoveredModels(discovered)
  return {
    discoveredAtByAgentByHost: {
      ...config.discoveredAtByAgentByHost,
      [hostKey]: { ...config.discoveredAtByAgentByHost?.[hostKey], [agentId]: listedAt }
    },
    discoveredModelsByAgent:
      hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
        ? { ...config.discoveredModelsByAgent, [agentId]: models }
        : config.discoveredModelsByAgent,
    discoveredModelsByAgentByHost: {
      ...config.discoveredModelsByAgentByHost,
      [hostKey]: { ...config.discoveredModelsByAgentByHost?.[hostKey], [agentId]: models }
    }
  }
}

/** A recent account listing for the host, or null when none bounds what runs. */
export function getFreshAccountModelListing(
  source: SourceControlAiSettings,
  legacy: CommitMessageAiSettings | null | undefined,
  hostKey: string,
  agentId: TuiAgent
): CommitMessageAiModelCapability[] | null {
  // Codex's model/list is the signed-in account's own list, so a fresh one bounds what runs; an older
  // one may be another login's or predate a new model, and Codex's refusal retry covers that case.
  const listedAt = source.discoveredAtByAgentByHost?.[hostKey]?.[agentId]
  if (
    !listsAccountModels(agentId) ||
    listedAt === undefined ||
    Date.now() - listedAt >= ACCOUNT_LISTING_FRESH_MS
  ) {
    return null
  }
  const discovered = getDiscoveredModels(source, legacy, hostKey, agentId)
  return discovered.length > 0 ? discovered : null
}

/** The models generation can run for an agent on a host, in its lookup order: spec, then saved discovery. */
export function getTextGenerationModels<T extends CommitMessageAiModelCapability>(
  specModels: readonly T[],
  source: SourceControlAiSettings,
  legacy: CommitMessageAiSettings | null | undefined,
  hostKey: string,
  agentId: TuiAgent
): (T | CommitMessageAiModelCapability)[] {
  const listing = getFreshAccountModelListing(source, legacy, hostKey, agentId)
  if (listing) {
    return listing
  }
  const discovered = getDiscoveredModels(source, legacy, hostKey, agentId)
  const specIds = new Set(specModels.map((model) => model.id))
  return [...specModels, ...discovered.filter((model) => !specIds.has(model.id))]
}

// The settings picker re-lists on open, so a day bounds how long a login switch can hide a model.
const ACCOUNT_LISTING_FRESH_MS = 24 * 60 * 60 * 1000

/** Whether the agent lists the signed-in account's models (Codex's app-server `model/list`). */
export function listsAccountModels(agentId: TuiAgent): boolean {
  const discovery = getCommitMessageAgentSpec(agentId)?.modelDiscovery
  return discovery !== undefined && 'listing' in discovery
}

// Dictated text waits on cleanup before it lands, so cleanup starts on each agent's quickest model.
const DICTATION_CLEANUP_MODEL_BY_AGENT: Partial<Record<TuiAgent, string>> = {
  claude: 'haiku',
  codex: 'gpt-5.4-mini'
}

/** The nearest saved pick the host can run; a pick it can't run falls through to the next level. */
export function selectPersistedModelId(args: {
  source: SourceControlAiSettings
  legacy: CommitMessageAiSettings | null | undefined
  repoOverrides: RepoSourceControlAiOverrides | null | undefined
  operation: AiTextOperation
  hostKey: string
  agentId: TuiAgent
  isAvailable: (modelId: string) => boolean
}): string | undefined {
  const { source, legacy, repoOverrides, operation, hostKey, agentId } = args
  const picks = [
    isGlobalAiTextAction(operation)
      ? undefined
      : readSourceControlAiModelChoiceForHost(
          repoOverrides?.modelOverridesByOperation?.[operation],
          hostKey,
          agentId
        ),
    readSourceControlAiModelChoiceForHost(
      source.modelOverridesByOperation?.[operation],
      hostKey,
      agentId
    ),
    operation === 'dictationCleanup' ? DICTATION_CLEANUP_MODEL_BY_AGENT[agentId] : undefined,
    readSourceControlAiModelChoiceForHost(
      {
        selectedModelByAgent: source.selectedModelByAgent,
        selectedModelByAgentByHost: source.selectedModelByAgentByHost
      },
      hostKey,
      agentId
    ),
    legacy?.selectedModelByAgentByHost?.[hostKey]?.[agentId],
    hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY ? legacy?.selectedModelByAgent?.[agentId] : undefined
  ]
  return picks.find((pick) => pick !== undefined && args.isAvailable(pick))
}

export function resolveThinkingLevel(args: {
  model: CommitMessageAiModelCapability
  source: SourceControlAiSettings
  legacy: CommitMessageAiSettings | null | undefined
  repoOverrides: RepoSourceControlAiOverrides | null | undefined
  operation: AiTextOperation
}): string | undefined {
  if (!args.model.thinkingLevels?.length) {
    return undefined
  }
  const persisted =
    (isGlobalAiTextAction(args.operation)
      ? undefined
      : args.repoOverrides?.modelOverridesByOperation?.[args.operation]?.selectedThinkingByModel?.[
          args.model.id
        ]) ??
    args.source.modelOverridesByOperation?.[args.operation]?.selectedThinkingByModel?.[
      args.model.id
    ] ??
    args.source.selectedThinkingByModel[args.model.id] ??
    args.legacy?.selectedThinkingByModel?.[args.model.id]
  return args.model.thinkingLevels.some((level) => level.id === persisted)
    ? persisted
    : args.model.defaultThinkingLevel
}
