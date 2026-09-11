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

export function normalizePiConfiguredDefaultForLegacy(choice: {
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
  const state: PiConfiguredDefaultModelState =
    args.persistedState?.version === 1
      ? structuredClone(args.persistedState)
      : { version: 1, defaultsByHost: {}, commitMessageSeedByHost: {} }
  let changed = !args.persistedState
  // Historical Copilot selections have no provenance; preserve them as explicit choices.
  for (const [choice, marks] of [
    [sourceControlAi, state.defaultsByHost],
    [sourceControlAi.modelOverridesByOperation?.commitMessage, state.commitMessageSeedByHost]
  ] as const) {
    if (!choice) {
      continue
    }
    const hostKeys = new Set(['local', ...Object.keys(choice.selectedModelByAgentByHost ?? {})])
    for (const hostKey of hostKeys) {
      if (modelForHost(choice, hostKey) === PI_DEFAULT_MODEL_ID) {
        marks[hostKey] = true
        changed = true
      }
    }
  }
  if (commitMessageAi) {
    changed = normalizePiConfiguredDefaultForLegacy(commitMessageAi) || changed
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
  return state
}
