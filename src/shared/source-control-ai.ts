/* eslint-disable max-lines -- Why: defaults, migration compatibility, and
   operation resolution stay together so source-control AI precedence rules
   cannot drift across commit-message, PR, repo, local, SSH, and runtime paths. */
import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId,
  resolveCommitMessageAgentChoice
} from './commit-message-agent-spec'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from './commit-message-host-key'
import type {
  CommitMessageAiModelCapability,
  CommitMessageAiSettings,
  GlobalSettings,
  Repo,
  TuiAgent
} from './types'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiModelChoice,
  SourceControlAiOperation,
  SourceControlAiPrCreationDefaults,
  SourceControlAiSettings
} from './source-control-ai-types'

export const DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS: Required<SourceControlAiPrCreationDefaults> =
  {
    draft: false,
    useTemplate: false,
    generateDetailsOnOpen: false,
    openAfterCreate: false
  }

export type ResolvedSourceControlAiGenerationParams = {
  agentId: TuiAgent | 'custom'
  model: string
  thinkingLevel?: string
  customPrompt?: string
  customAgentCommand?: string
  agentCommandOverride?: string
}

export type ResolvedSourceControlAiOperation = {
  enabled: boolean
  params: ResolvedSourceControlAiGenerationParams
  prCreationDefaults: Required<SourceControlAiPrCreationDefaults>
}

export type ResolveSourceControlAiResult =
  | { ok: true; value: ResolvedSourceControlAiOperation }
  | { ok: false; error: string }

type ResolveSourceControlAiInput = {
  settings: Pick<
    GlobalSettings,
    'defaultTuiAgent' | 'agentCmdOverrides' | 'commitMessageAi' | 'sourceControlAi'
  > &
    Partial<Pick<GlobalSettings, 'disabledTuiAgents'>>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  operation: SourceControlAiOperation
  discoveryHostKey?: string
  prCreationProductDefaults?: SourceControlAiPrCreationDefaults
}

export type ResolveSourceControlAiPrCreationDefaultsInput = {
  settings: Pick<GlobalSettings, 'commitMessageAi' | 'sourceControlAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  prCreationProductDefaults?: SourceControlAiPrCreationDefaults
}

const OPERATION_LABEL: Record<SourceControlAiOperation, string> = {
  commitMessage: 'commit messages',
  pullRequest: 'pull request details',
  branchName: 'branch names'
}

const SOURCE_CONTROL_AI_OPERATIONS = ['commitMessage', 'pullRequest', 'branchName'] as const
const PR_CREATION_DEFAULT_KEYS = [
  'draft',
  'useTemplate',
  'generateDetailsOnOpen',
  'openAfterCreate'
] as const

function copyRecord<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasEntries(value: Record<string, unknown> | null | undefined): boolean {
  return Object.keys(value ?? {}).length > 0
}

function isSafeRecordKey(key: string): boolean {
  return key !== '' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSafeRecordKey(key) && typeof item === 'string') {
      normalized[key] = item
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeAgentModelRecord(value: unknown): Partial<Record<TuiAgent, string>> | undefined {
  return normalizeStringRecord(value) as Partial<Record<TuiAgent, string>> | undefined
}

function normalizeHostAgentModelRecord(
  value: unknown
): Partial<Record<string, Partial<Record<TuiAgent, string>>>> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: Partial<Record<string, Partial<Record<TuiAgent, string>>>> = {}
  for (const [hostKey, hostModels] of Object.entries(value)) {
    if (!isSafeRecordKey(hostKey)) {
      continue
    }
    const normalizedHostModels = normalizeAgentModelRecord(hostModels)
    if (normalizedHostModels) {
      normalized[hostKey] = normalizedHostModels
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeSourceControlAiModelChoice(
  value: unknown
): SourceControlAiModelChoice | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const choice: SourceControlAiModelChoice = {}
  const selectedModelByAgent = normalizeAgentModelRecord(value.selectedModelByAgent)
  if (selectedModelByAgent) {
    choice.selectedModelByAgent = selectedModelByAgent
  }
  const selectedModelByAgentByHost = normalizeHostAgentModelRecord(value.selectedModelByAgentByHost)
  if (selectedModelByAgentByHost) {
    choice.selectedModelByAgentByHost = selectedModelByAgentByHost
  }
  const selectedThinkingByModel = normalizeStringRecord(value.selectedThinkingByModel)
  if (selectedThinkingByModel) {
    choice.selectedThinkingByModel = selectedThinkingByModel
  }
  return Object.keys(choice).length > 0 ? choice : undefined
}

function normalizeOperationRecord<T>(
  value: unknown,
  normalizeValue: (value: unknown) => T | undefined
): Partial<Record<SourceControlAiOperation, T>> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: Partial<Record<SourceControlAiOperation, T>> = {}
  for (const operation of SOURCE_CONTROL_AI_OPERATIONS) {
    if (!Object.prototype.hasOwnProperty.call(value, operation)) {
      continue
    }
    const normalizedValue = normalizeValue(value[operation])
    if (normalizedValue !== undefined) {
      normalized[operation] = normalizedValue
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeRepoInstruction(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null ? value : undefined
}

function normalizeRepoPrCreationDefaults(
  value: unknown
): RepoSourceControlAiOverrides['prCreationDefaults'] {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: NonNullable<RepoSourceControlAiOverrides['prCreationDefaults']> = {}
  for (const key of PR_CREATION_DEFAULT_KEYS) {
    const item = value[key]
    if (typeof item === 'boolean' || item === null) {
      normalized[key] = item
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function normalizeRepoSourceControlAiOverrides(
  value: unknown
): RepoSourceControlAiOverrides | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: RepoSourceControlAiOverrides = {}
  const modelOverridesByOperation = normalizeOperationRecord(
    value.modelOverridesByOperation,
    normalizeSourceControlAiModelChoice
  )
  if (modelOverridesByOperation) {
    normalized.modelOverridesByOperation = modelOverridesByOperation
  }
  const instructionsByOperation = normalizeOperationRecord(
    value.instructionsByOperation,
    normalizeRepoInstruction
  )
  if (instructionsByOperation) {
    normalized.instructionsByOperation = instructionsByOperation
  }
  const prCreationDefaults = normalizeRepoPrCreationDefaults(value.prCreationDefaults)
  if (prCreationDefaults) {
    normalized.prCreationDefaults = prCreationDefaults
  }
  return normalized
}

export function getDefaultSourceControlAiSettings(): SourceControlAiSettings {
  return {
    enabled: true,
    agentId: null,
    selectedModelByAgent: {},
    selectedModelByAgentByHost: {},
    discoveredModelsByAgent: {},
    discoveredModelsByAgentByHost: {},
    selectedThinkingByModel: {},
    customAgentCommand: '',
    instructionsByOperation: {
      commitMessage: '',
      pullRequest: '',
      branchName: ''
    },
    prCreationDefaults: { ...DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS }
  }
}

export function sourceControlAiSettingsFromLegacy(
  legacy: CommitMessageAiSettings | null | undefined
): SourceControlAiSettings {
  const defaults = getDefaultSourceControlAiSettings()
  if (!legacy) {
    return defaults
  }
  return {
    ...defaults,
    enabled: legacy.enabled,
    agentId: legacy.agentId,
    selectedModelByAgent: { ...legacy.selectedModelByAgent },
    selectedModelByAgentByHost: copyRecord(legacy.selectedModelByAgentByHost) ?? {},
    discoveredModelsByAgent: copyRecord(legacy.discoveredModelsByAgent) ?? {},
    discoveredModelsByAgentByHost: copyRecord(legacy.discoveredModelsByAgentByHost) ?? {},
    selectedThinkingByModel: { ...legacy.selectedThinkingByModel },
    customAgentCommand: legacy.customAgentCommand,
    instructionsByOperation: {
      commitMessage: legacy.customPrompt ?? '',
      // Why: the legacy prompt covered commit generation and branch auto-rename;
      // the first split must preserve that guidance for both released paths.
      pullRequest: '',
      branchName: legacy.customPrompt ?? ''
    }
  }
}

function mergeSelectedModelByAgentByHost(
  base: Partial<Record<string, Partial<Record<TuiAgent, string>>>> | undefined,
  override: Partial<Record<string, Partial<Record<TuiAgent, string>>>> | undefined
): Partial<Record<string, Partial<Record<TuiAgent, string>>>> {
  const merged = copyRecord(base) ?? {}
  for (const [hostKey, hostModels] of Object.entries(override ?? {})) {
    merged[hostKey] = {
      ...merged[hostKey],
      ...hostModels
    }
  }
  return merged
}

function mergeLegacyModelSelectionDelta<T>(
  existing: Record<string, T> | null | undefined,
  legacy: Record<string, T> | null | undefined,
  projected: Record<string, T> | null | undefined
): Record<string, T> | undefined {
  const merged: Record<string, T> = { ...existing }
  let changed = false
  const keys = new Set([...Object.keys(legacy ?? {}), ...Object.keys(projected ?? {})])
  for (const key of keys) {
    const legacyHasKey = Object.prototype.hasOwnProperty.call(legacy ?? {}, key)
    const legacyValue = legacy?.[key]
    if (JSON.stringify(projected?.[key]) === JSON.stringify(legacyValue)) {
      continue
    }
    changed = true
    if (legacyHasKey && legacyValue !== undefined) {
      merged[key] = legacyValue
    } else {
      delete merged[key]
    }
  }
  return changed ? merged : (existing ?? undefined)
}

function mergeLegacyHostModelSelectionDelta(
  existing: Partial<Record<string, Partial<Record<TuiAgent, string>>>> | null | undefined,
  legacy: Partial<Record<string, Partial<Record<TuiAgent, string>>>> | null | undefined,
  projected: Partial<Record<string, Partial<Record<TuiAgent, string>>>> | null | undefined
): Partial<Record<string, Partial<Record<TuiAgent, string>>>> | undefined {
  const merged = copyRecord(existing) ?? {}
  let changed = false
  const hostKeys = new Set([...Object.keys(legacy ?? {}), ...Object.keys(projected ?? {})])
  for (const hostKey of hostKeys) {
    const nextHostModels = mergeLegacyModelSelectionDelta(
      merged[hostKey],
      legacy?.[hostKey],
      projected?.[hostKey]
    )
    if (nextHostModels !== merged[hostKey]) {
      changed = true
    }
    if (nextHostModels && Object.keys(nextHostModels).length > 0) {
      merged[hostKey] = nextHostModels
    } else {
      delete merged[hostKey]
    }
  }
  return changed ? merged : (existing ?? undefined)
}

export function mergeLegacyCommitMessageAiIntoSourceControlAi(
  sourceControlAi: SourceControlAiSettings | null | undefined,
  legacy: CommitMessageAiSettings | null | undefined,
  options: { pullRequestInstructionsFromLegacy?: boolean } = {}
): SourceControlAiSettings {
  // Why: older runtimes and rollback builds still write commitMessageAi; merge
  // those writes into the new shape without wiping PR-only settings.
  const base = normalizeSourceControlAiSettings(sourceControlAi, legacy)
  if (!legacy) {
    return base
  }
  if (sourceControlAi) {
    const existingCommitChoice = base.modelOverridesByOperation?.commitMessage
    const projectedLegacy = projectSourceControlAiToLegacyCommitMessageAi(base)
    const selectedModelByAgent = mergeLegacyModelSelectionDelta(
      existingCommitChoice?.selectedModelByAgent,
      legacy.selectedModelByAgent,
      projectedLegacy.selectedModelByAgent
    )
    const selectedModelByAgentByHost = mergeLegacyHostModelSelectionDelta(
      existingCommitChoice?.selectedModelByAgentByHost,
      legacy.selectedModelByAgentByHost,
      projectedLegacy.selectedModelByAgentByHost
    )
    const selectedThinkingByModel = mergeLegacyModelSelectionDelta(
      existingCommitChoice?.selectedThinkingByModel,
      legacy.selectedThinkingByModel,
      projectedLegacy.selectedThinkingByModel
    )
    const shouldMergeLegacyModels =
      selectedModelByAgent !== existingCommitChoice?.selectedModelByAgent ||
      selectedModelByAgentByHost !== existingCommitChoice?.selectedModelByAgentByHost ||
      selectedThinkingByModel !== existingCommitChoice?.selectedThinkingByModel
    const nextModelOverridesByOperation = { ...base.modelOverridesByOperation }
    if (shouldMergeLegacyModels) {
      const nextCommitChoice: SourceControlAiModelChoice = {}
      if (hasEntries(selectedModelByAgent)) {
        nextCommitChoice.selectedModelByAgent = selectedModelByAgent
      }
      if (hasEntries(selectedModelByAgentByHost)) {
        nextCommitChoice.selectedModelByAgentByHost = selectedModelByAgentByHost
      }
      if (hasEntries(selectedThinkingByModel)) {
        nextCommitChoice.selectedThinkingByModel = selectedThinkingByModel
      }
      if (Object.keys(nextCommitChoice).length > 0) {
        nextModelOverridesByOperation.commitMessage = nextCommitChoice
      } else {
        delete nextModelOverridesByOperation.commitMessage
      }
    }
    // Why: rollback builds write commitMessageAi, while new builds project
    // commit-message overrides there. Keep those model choices scoped to
    // commit-message generation so PR defaults cannot drift on reload.
    return normalizeSourceControlAiSettings(
      {
        ...base,
        enabled: legacy.enabled,
        agentId: legacy.agentId,
        discoveredModelsByAgent: copyRecord(legacy.discoveredModelsByAgent) ?? {},
        discoveredModelsByAgentByHost: copyRecord(legacy.discoveredModelsByAgentByHost) ?? {},
        customAgentCommand: legacy.customAgentCommand,
        instructionsByOperation: {
          ...base.instructionsByOperation,
          commitMessage: legacy.customPrompt ?? '',
          branchName: legacy.customPrompt ?? '',
          ...(options.pullRequestInstructionsFromLegacy
            ? { pullRequest: legacy.customPrompt ?? '' }
            : {})
        },
        modelOverridesByOperation: nextModelOverridesByOperation
      },
      legacy
    )
  }
  return normalizeSourceControlAiSettings(
    {
      ...base,
      enabled: legacy.enabled,
      agentId: legacy.agentId,
      selectedModelByAgent: { ...legacy.selectedModelByAgent },
      selectedModelByAgentByHost: copyRecord(legacy.selectedModelByAgentByHost) ?? {},
      discoveredModelsByAgent: copyRecord(legacy.discoveredModelsByAgent) ?? {},
      discoveredModelsByAgentByHost: copyRecord(legacy.discoveredModelsByAgentByHost) ?? {},
      selectedThinkingByModel: { ...legacy.selectedThinkingByModel },
      customAgentCommand: legacy.customAgentCommand,
      instructionsByOperation: {
        ...base.instructionsByOperation,
        commitMessage: legacy.customPrompt ?? '',
        branchName: legacy.customPrompt ?? '',
        ...(options.pullRequestInstructionsFromLegacy
          ? { pullRequest: legacy.customPrompt ?? '' }
          : {})
      }
    },
    legacy
  )
}

export function normalizeSourceControlAiSettings(
  value: SourceControlAiSettings | null | undefined,
  legacy?: CommitMessageAiSettings | null
): SourceControlAiSettings {
  const base = value ?? sourceControlAiSettingsFromLegacy(legacy)
  const defaults = getDefaultSourceControlAiSettings()
  return {
    ...defaults,
    ...base,
    selectedModelByAgent: { ...defaults.selectedModelByAgent, ...base.selectedModelByAgent },
    selectedModelByAgentByHost:
      copyRecord(base.selectedModelByAgentByHost) ?? defaults.selectedModelByAgentByHost,
    discoveredModelsByAgent:
      copyRecord(base.discoveredModelsByAgent) ?? defaults.discoveredModelsByAgent,
    discoveredModelsByAgentByHost:
      copyRecord(base.discoveredModelsByAgentByHost) ?? defaults.discoveredModelsByAgentByHost,
    selectedThinkingByModel: {
      ...defaults.selectedThinkingByModel,
      ...base.selectedThinkingByModel
    },
    instructionsByOperation: {
      ...defaults.instructionsByOperation,
      ...base.instructionsByOperation
    },
    modelOverridesByOperation: copyRecord(base.modelOverridesByOperation),
    prCreationDefaults: {
      ...defaults.prCreationDefaults,
      ...base.prCreationDefaults
    }
  }
}

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
  const hostSelectedModels = choice?.selectedModelByAgentByHost?.[hostKey] ?? {}
  return {
    ...choice,
    selectedModelByAgent:
      hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
        ? {
            ...choice?.selectedModelByAgent,
            [agentId]: modelId
          }
        : choice?.selectedModelByAgent,
    selectedModelByAgentByHost: {
      ...choice?.selectedModelByAgentByHost,
      [hostKey]: {
        ...hostSelectedModels,
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
  // Why: model choices are host-scoped; clearing one "Use global" selector
  // must not erase a different SSH/runtime host's override.
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

export function projectSourceControlAiToLegacyCommitMessageAi(
  sourceControlAi: SourceControlAiSettings,
  previousLegacy?: CommitMessageAiSettings | null
): CommitMessageAiSettings {
  const commitMessageChoice = sourceControlAi.modelOverridesByOperation?.commitMessage
  return {
    enabled: sourceControlAi.enabled,
    agentId: sourceControlAi.agentId,
    selectedModelByAgent: {
      ...sourceControlAi.selectedModelByAgent,
      ...commitMessageChoice?.selectedModelByAgent
    },
    selectedModelByAgentByHost: mergeSelectedModelByAgentByHost(
      sourceControlAi.selectedModelByAgentByHost,
      commitMessageChoice?.selectedModelByAgentByHost
    ),
    discoveredModelsByAgent: copyRecord(sourceControlAi.discoveredModelsByAgent) ?? {},
    discoveredModelsByAgentByHost: copyRecord(sourceControlAi.discoveredModelsByAgentByHost) ?? {},
    selectedThinkingByModel: {
      ...sourceControlAi.selectedThinkingByModel,
      ...commitMessageChoice?.selectedThinkingByModel
    },
    customPrompt:
      sourceControlAi.instructionsByOperation.commitMessage ?? previousLegacy?.customPrompt ?? '',
    customAgentCommand: sourceControlAi.customAgentCommand
  }
}

function readDefaultSelectedModelId(
  settings: Pick<SourceControlAiSettings, 'selectedModelByAgent' | 'selectedModelByAgentByHost'>,
  hostKey: string,
  agentId: TuiAgent
): string | undefined {
  return readSourceControlAiModelChoiceForHost(
    {
      selectedModelByAgent: settings.selectedModelByAgent,
      selectedModelByAgentByHost: settings.selectedModelByAgentByHost
    },
    hostKey,
    agentId
  )
}

function getDiscoveredModels(
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

function selectPersistedModelId(args: {
  source: SourceControlAiSettings
  legacy: CommitMessageAiSettings | null | undefined
  repoOverrides: RepoSourceControlAiOverrides | null | undefined
  operation: SourceControlAiOperation
  hostKey: string
  agentId: TuiAgent
  defaultModelId: string
}): string {
  const { source, legacy, repoOverrides, operation, hostKey, agentId, defaultModelId } = args
  return (
    readSourceControlAiModelChoiceForHost(
      repoOverrides?.modelOverridesByOperation?.[operation],
      hostKey,
      agentId
    ) ??
    readSourceControlAiModelChoiceForHost(
      source.modelOverridesByOperation?.[operation],
      hostKey,
      agentId
    ) ??
    readDefaultSelectedModelId(source, hostKey, agentId) ??
    legacy?.selectedModelByAgentByHost?.[hostKey]?.[agentId] ??
    (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
      ? legacy?.selectedModelByAgent?.[agentId]
      : undefined) ??
    defaultModelId
  )
}

function resolveThinkingLevel(args: {
  model: CommitMessageAiModelCapability
  source: SourceControlAiSettings
  legacy: CommitMessageAiSettings | null | undefined
  repoOverrides: RepoSourceControlAiOverrides | null | undefined
  operation: SourceControlAiOperation
}): string | undefined {
  const { model, source, legacy, repoOverrides, operation } = args
  if (!model.thinkingLevels?.length) {
    return undefined
  }
  const persisted =
    repoOverrides?.modelOverridesByOperation?.[operation]?.selectedThinkingByModel?.[model.id] ??
    source.modelOverridesByOperation?.[operation]?.selectedThinkingByModel?.[model.id] ??
    source.selectedThinkingByModel[model.id] ??
    legacy?.selectedThinkingByModel?.[model.id]
  return model.thinkingLevels.some((level) => level.id === persisted)
    ? persisted
    : model.defaultThinkingLevel
}

function hasOwnInstruction(
  instructions: Partial<Record<SourceControlAiOperation, string | null>> | null | undefined,
  operation: SourceControlAiOperation
): boolean {
  return Object.prototype.hasOwnProperty.call(instructions ?? {}, operation)
}

function readRepoInstructionOverride(
  instructions: RepoSourceControlAiOverrides['instructionsByOperation'],
  operation: SourceControlAiOperation
): string | undefined {
  if (!hasOwnInstruction(instructions, operation)) {
    return undefined
  }
  const instruction = instructions?.[operation]
  return typeof instruction === 'string' ? instruction : undefined
}

export function resolveSourceControlAiInstructions(args: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  operation: SourceControlAiOperation
}): string {
  const source = normalizeSourceControlAiSettings(
    args.settings.sourceControlAi,
    args.settings.commitMessageAi
  )
  const repoOverrides = normalizeRepoSourceControlAiOverrides(args.repo?.sourceControlAi)
  const repoInstruction = readRepoInstructionOverride(
    repoOverrides?.instructionsByOperation,
    args.operation
  )
  if (repoInstruction !== undefined) {
    return repoInstruction.trim()
  }
  const globalInstruction = source.instructionsByOperation[args.operation]
  if (typeof globalInstruction === 'string') {
    return globalInstruction.trim()
  }
  return args.operation === 'commitMessage'
    ? (args.settings.commitMessageAi?.customPrompt ?? '').trim()
    : ''
}

export function hasConfiguredSourceControlAiInstructions(args: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  operation: SourceControlAiOperation
}): boolean {
  const repoOverrides = normalizeRepoSourceControlAiOverrides(args.repo?.sourceControlAi)
  const repoInstruction = readRepoInstructionOverride(
    repoOverrides?.instructionsByOperation,
    args.operation
  )
  if (repoInstruction !== undefined) {
    return true
  }
  return resolveSourceControlAiInstructions(args).length > 0
}

function resolvePrCreationDefaults(
  source: SourceControlAiSettings,
  repoOverrides: RepoSourceControlAiOverrides | null | undefined,
  productDefaults: SourceControlAiPrCreationDefaults | undefined
): Required<SourceControlAiPrCreationDefaults> {
  const base = {
    ...DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
    ...productDefaults,
    ...source.prCreationDefaults
  }
  const repoDefaults = repoOverrides?.prCreationDefaults
  if (!repoDefaults) {
    return base
  }
  return {
    draft: repoDefaults.draft ?? base.draft,
    useTemplate: repoDefaults.useTemplate ?? base.useTemplate,
    generateDetailsOnOpen: repoDefaults.generateDetailsOnOpen ?? base.generateDetailsOnOpen,
    openAfterCreate: repoDefaults.openAfterCreate ?? base.openAfterCreate
  }
}

export function resolveSourceControlAiPrCreationDefaults(
  input: ResolveSourceControlAiPrCreationDefaultsInput
): Required<SourceControlAiPrCreationDefaults> {
  const source = normalizeSourceControlAiSettings(
    input.settings.sourceControlAi,
    input.settings.commitMessageAi
  )
  return resolvePrCreationDefaults(
    source,
    normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi),
    input.prCreationProductDefaults
  )
}

export function resolveSourceControlAiForOperation(
  input: ResolveSourceControlAiInput
): ResolveSourceControlAiResult {
  const legacy = input.settings.commitMessageAi
  const source = normalizeSourceControlAiSettings(input.settings.sourceControlAi, legacy)
  if (!source.enabled) {
    return {
      ok: false,
      error: 'Enable Git AI Author in Settings -> Git.'
    }
  }

  // Why: a normalized null means "use the current default agent"; stale legacy
  // commitMessageAi should not make that choice sticky again.
  const agentChoice = resolveCommitMessageAgentChoice(
    source.agentId,
    input.settings.defaultTuiAgent,
    input.settings.disabledTuiAgents
  )
  if (!agentChoice) {
    return {
      ok: false,
      error:
        `Default agent "${input.settings.defaultTuiAgent}" does not support Git AI Author. ` +
        'Choose Claude, Codex, or Custom in Settings -> Git -> Git AI Author.'
    }
  }

  const repoOverrides = normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi)
  const prCreationDefaults = resolvePrCreationDefaults(
    source,
    repoOverrides,
    input.prCreationProductDefaults
  )

  if (isCustomAgentId(agentChoice)) {
    const customAgentCommand = source.customAgentCommand.trim()
    if (!customAgentCommand) {
      return {
        ok: false,
        error: 'Custom command is empty. Add one in Settings -> Git -> Git AI Author.'
      }
    }
    return {
      ok: true,
      value: {
        enabled: true,
        params: {
          agentId: CUSTOM_AGENT_ID,
          model: '',
          customPrompt: resolveSourceControlAiInstructions(input),
          customAgentCommand
        },
        prCreationDefaults
      }
    }
  }

  const agentId = agentChoice
  const spec = getCommitMessageAgentSpec(agentId)
  if (!spec) {
    return {
      ok: false,
      error: `Agent "${agentId}" does not support Git AI Author ${OPERATION_LABEL[input.operation]}.`
    }
  }

  const hostKey = input.discoveryHostKey ?? LOCAL_COMMIT_MESSAGE_HOST_KEY
  const persistedModelId = selectPersistedModelId({
    source,
    legacy,
    repoOverrides,
    operation: input.operation,
    hostKey,
    agentId,
    defaultModelId: spec.defaultModelId
  })
  const discoveredModels = getDiscoveredModels(source, legacy, hostKey, agentId)
  const model =
    spec.models.find((candidate) => candidate.id === persistedModelId) ??
    discoveredModels.find((candidate) => candidate.id === persistedModelId) ??
    getCommitMessageModel(agentId, spec.defaultModelId)
  if (!model) {
    return { ok: false, error: `No model is available for ${spec.label}.` }
  }

  const thinkingLevel = resolveThinkingLevel({
    model,
    source,
    legacy,
    repoOverrides,
    operation: input.operation
  })
  const agentCommandOverride = input.settings.agentCmdOverrides?.[agentId]?.trim()
  return {
    ok: true,
    value: {
      enabled: true,
      params: {
        agentId,
        model: model.id,
        thinkingLevel,
        customPrompt: resolveSourceControlAiInstructions(input),
        ...(agentCommandOverride ? { agentCommandOverride } : {})
      },
      prCreationDefaults
    }
  }
}
