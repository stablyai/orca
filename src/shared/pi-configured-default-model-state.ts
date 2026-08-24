import {
  PI_DEFAULT_MODEL_ID,
  PI_RETIRED_COPILOT_DEFAULT_MODEL_ID
} from './commit-message-agent-spec'
import type { CommitMessageAiSettings } from './commit-message-ai-types'
import type { GlobalSettings } from './global-settings-types'
import type { SourceControlAiSettings } from './source-control-ai-types'

export type PiConfiguredDefaultModelState = NonNullable<
  GlobalSettings['piConfiguredDefaultModelState']
>

function normalizeModelId(modelId: string | undefined): string | undefined {
  return modelId === PI_DEFAULT_MODEL_ID ? PI_RETIRED_COPILOT_DEFAULT_MODEL_ID : modelId
}

function normalizeChoice(choice: {
  selectedModelByAgent?: Partial<Record<string, string>>
  selectedModelByAgentByHost?: Partial<Record<string, Partial<Record<string, string>>>>
}): boolean {
  let changed = false
  if (choice.selectedModelByAgent?.pi === PI_DEFAULT_MODEL_ID) {
    choice.selectedModelByAgent.pi = PI_RETIRED_COPILOT_DEFAULT_MODEL_ID
    changed = true
  }
  for (const hostModels of Object.values(choice.selectedModelByAgentByHost ?? {})) {
    if (hostModels?.pi === PI_DEFAULT_MODEL_ID) {
      hostModels.pi = PI_RETIRED_COPILOT_DEFAULT_MODEL_ID
      changed = true
    }
  }
  return changed
}

export function migratePiConfiguredDefaultModelState(args: {
  sourceControlAi: SourceControlAiSettings
  commitMessageAi: CommitMessageAiSettings | null | undefined
  persistedState: GlobalSettings['piConfiguredDefaultModelState']
}): { state: PiConfiguredDefaultModelState; changed: boolean } {
  const { sourceControlAi, commitMessageAi } = args
  let changed = normalizeChoice(sourceControlAi)
  if (commitMessageAi) {
    changed = normalizeChoice(commitMessageAi) || changed
  }
  for (const choice of Object.values(sourceControlAi.modelOverridesByOperation ?? {})) {
    if (choice) {
      changed = normalizeChoice(choice) || changed
    }
  }

  const state: PiConfiguredDefaultModelState =
    args.persistedState?.version === 1
      ? structuredClone(args.persistedState)
      : { version: 1, defaultsByHost: {}, commitMessageSeedByHost: {} }
  if (!args.persistedState) {
    const localModel =
      sourceControlAi.selectedModelByAgentByHost?.local?.pi ??
      sourceControlAi.selectedModelByAgent.pi
    if (normalizeModelId(localModel) === PI_RETIRED_COPILOT_DEFAULT_MODEL_ID) {
      state.defaultsByHost.local = true
    }
    for (const [hostKey, models] of Object.entries(
      sourceControlAi.selectedModelByAgentByHost ?? {}
    )) {
      if (normalizeModelId(models?.pi) === PI_RETIRED_COPILOT_DEFAULT_MODEL_ID) {
        state.defaultsByHost[hostKey] = true
      }
    }
    const commitChoice = sourceControlAi.modelOverridesByOperation?.commitMessage
    const legacyLocal =
      commitMessageAi?.selectedModelByAgentByHost?.local?.pi ??
      commitMessageAi?.selectedModelByAgent.pi
    const commitLocal =
      commitChoice?.selectedModelByAgentByHost?.local?.pi ?? commitChoice?.selectedModelByAgent?.pi
    if (
      normalizeModelId(commitLocal) === PI_RETIRED_COPILOT_DEFAULT_MODEL_ID &&
      normalizeModelId(legacyLocal) === PI_RETIRED_COPILOT_DEFAULT_MODEL_ID
    ) {
      state.commitMessageSeedByHost.local = true
    }
    for (const [hostKey, models] of Object.entries(
      commitChoice?.selectedModelByAgentByHost ?? {}
    )) {
      if (
        normalizeModelId(models?.pi) === PI_RETIRED_COPILOT_DEFAULT_MODEL_ID &&
        normalizeModelId(commitMessageAi?.selectedModelByAgentByHost?.[hostKey]?.pi) ===
          PI_RETIRED_COPILOT_DEFAULT_MODEL_ID
      ) {
        state.commitMessageSeedByHost[hostKey] = true
      }
    }
    changed = true
  }
  return { state, changed }
}

function modelForHost(
  choice: {
    selectedModelByAgent?: Partial<Record<string, string>>
    selectedModelByAgentByHost?: Partial<Record<string, Partial<Record<string, string>>>>
  },
  hostKey: string
): string | undefined {
  return (
    choice.selectedModelByAgentByHost?.[hostKey]?.pi ??
    (hostKey === 'local' ? choice.selectedModelByAgent?.pi : undefined)
  )
}

export function applyPiConfiguredDefaultSelectionUpdate(args: {
  previous: SourceControlAiSettings
  next: SourceControlAiSettings
  state: GlobalSettings['piConfiguredDefaultModelState']
}): PiConfiguredDefaultModelState {
  const state: PiConfiguredDefaultModelState =
    args.state?.version === 1
      ? structuredClone(args.state)
      : { version: 1, defaultsByHost: {}, commitMessageSeedByHost: {} }
  const hostKeys = new Set([
    'local',
    ...Object.keys(args.previous.selectedModelByAgentByHost ?? {}),
    ...Object.keys(args.next.selectedModelByAgentByHost ?? {})
  ])
  for (const hostKey of hostKeys) {
    const previous = modelForHost(args.previous, hostKey)
    const next = modelForHost(args.next, hostKey)
    if (next === previous) {
      continue
    }
    if (next === PI_DEFAULT_MODEL_ID) {
      state.defaultsByHost[hostKey] = true
    } else {
      delete state.defaultsByHost[hostKey]
    }
  }
  const previousCommit = args.previous.modelOverridesByOperation?.commitMessage ?? {}
  const nextCommit = args.next.modelOverridesByOperation?.commitMessage ?? {}
  const commitHostKeys = new Set([
    'local',
    ...Object.keys(previousCommit.selectedModelByAgentByHost ?? {}),
    ...Object.keys(nextCommit.selectedModelByAgentByHost ?? {})
  ])
  for (const hostKey of commitHostKeys) {
    const previous = modelForHost(previousCommit, hostKey)
    const next = modelForHost(nextCommit, hostKey)
    if (next === previous) {
      continue
    }
    if (next === PI_DEFAULT_MODEL_ID) {
      state.commitMessageSeedByHost[hostKey] = true
    } else {
      delete state.commitMessageSeedByHost[hostKey]
    }
  }
  normalizeChoice(args.next)
  if (args.next.modelOverridesByOperation?.commitMessage) {
    normalizeChoice(args.next.modelOverridesByOperation.commitMessage)
  }
  return state
}
