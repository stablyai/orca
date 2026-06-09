import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'
import type { SourceControlActionId } from '../../../../shared/source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import { SOURCE_CONTROL_TEXT_ACTION_ID_SET } from './source-control-action-recipe-options'

export type RepoAiDraftState = {
  repoId: string
  value: RepoSourceControlAiOverrides
  baseSerialized: string
}

export function hasOwnActionOverride(
  overrides: RepoSourceControlAiOverrides['actionOverrides'],
  actionId: SourceControlActionId
): boolean {
  return Object.prototype.hasOwnProperty.call(overrides ?? {}, actionId)
}

export function triStateValue(value: boolean | null | undefined): 'inherit' | 'on' | 'off' {
  if (value === true) {
    return 'on'
  }
  if (value === false) {
    return 'off'
  }
  return 'inherit'
}

export function normalizeRepoAiDraft(
  value: RepoSourceControlAiOverrides | null | undefined
): RepoSourceControlAiOverrides {
  return normalizeRepoSourceControlAiOverrides(value) ?? {}
}

export function serializeRepoAiDraft(value: RepoSourceControlAiOverrides): string {
  return JSON.stringify(normalizeRepoAiDraft(value))
}

export function createRepoAiDraftState(
  repoId: string,
  value: RepoSourceControlAiOverrides
): RepoAiDraftState {
  const normalized = normalizeRepoAiDraft(value)
  return {
    repoId,
    value: normalized,
    baseSerialized: serializeRepoAiDraft(normalized)
  }
}

export function resolveRepoAiDraftState(
  current: RepoAiDraftState,
  repoId: string,
  persistedRepoAi: RepoSourceControlAiOverrides,
  persistedSerialized = serializeRepoAiDraft(persistedRepoAi)
): RepoAiDraftState {
  const currentSerialized = serializeRepoAiDraft(current.value)
  // Why: render-time draft sync relies on object identity to avoid repeating
  // the same state update during server-rendered settings tests.
  if (
    current.repoId === repoId &&
    currentSerialized === persistedSerialized &&
    current.baseSerialized === persistedSerialized
  ) {
    return current
  }
  if (
    current.repoId !== repoId ||
    currentSerialized === current.baseSerialized ||
    currentSerialized === persistedSerialized
  ) {
    return {
      repoId,
      value: persistedRepoAi,
      baseSerialized: persistedSerialized
    }
  }
  return current
}

export function dropRepoLegacyInstructionForAction(
  value: RepoSourceControlAiOverrides,
  actionId: SourceControlActionId
): RepoSourceControlAiOverrides {
  if (!SOURCE_CONTROL_TEXT_ACTION_ID_SET.has(actionId) || !value.instructionsByOperation) {
    return value
  }
  const instructionsByOperation = { ...value.instructionsByOperation }
  delete instructionsByOperation[actionId as keyof typeof instructionsByOperation]
  return {
    ...value,
    instructionsByOperation:
      Object.keys(instructionsByOperation).length > 0 ? instructionsByOperation : undefined
  }
}
