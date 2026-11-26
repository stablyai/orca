import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import type {
  TaskResumeState,
  TaskViewPresetId
} from '../../../../../shared/ui-chrome/ui-chrome-types'
import type { FeatureInteractionState } from '../../../../../shared/feature-education/interactions/feature-interactions'
import type { ContextualTourId } from '../../../../../shared/feature-education/contextual-tours/contextual-tours'
import { normalizeFeatureInteractions } from '../../../../../shared/feature-education/interactions/feature-interactions'
import { normalizeContextualTourIds } from '../../../../../shared/feature-education/contextual-tours/contextual-tours'
import type { UISlice } from './ui-slice-contract'
import { isBundledPetId, DEFAULT_PET_ID } from '../../../components/pet/pet-models'
import { normalizeManualTagOrder } from '../../../../../shared/worktree/metadata/manual-tag-order'
import { sanitizePaneKeyTimestampRecord } from './ui-slice-hydration-sanitizers'

const VALID_TASK_PRESETS = new Set<TaskViewPresetId>([
  'all',
  'issues',
  'review',
  'my-issues',
  'my-prs',
  'prs'
])
const VALID_LINEAR_PRESETS = new Set<NonNullable<TaskResumeState['linearPreset']>>([
  'assigned',
  'created',
  'all',
  'completed'
])
const VALID_LINEAR_MODES = new Set<NonNullable<TaskResumeState['linearMode']>>([
  'issues',
  'projects',
  'views',
  'in-orca'
])
const VALID_JIRA_PRESETS = new Set<NonNullable<TaskResumeState['jiraPreset']>>([
  'assigned',
  'reported',
  'all',
  'done'
])

export function sanitizeTaskResumeState(value: unknown): TaskResumeState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const input = value as Record<string, unknown>
  const next: TaskResumeState = {}
  if (input.githubMode === 'items' || input.githubMode === 'project') {
    next.githubMode = input.githubMode
  }
  if (input.githubItemsPreset === null) {
    next.githubItemsPreset = null
  } else if (
    typeof input.githubItemsPreset === 'string' &&
    VALID_TASK_PRESETS.has(input.githubItemsPreset as TaskViewPresetId)
  ) {
    next.githubItemsPreset = input.githubItemsPreset as TaskViewPresetId
  }
  if (typeof input.githubItemsQuery === 'string') {
    next.githubItemsQuery = input.githubItemsQuery
  }
  if (
    typeof input.linearPreset === 'string' &&
    VALID_LINEAR_PRESETS.has(input.linearPreset as NonNullable<TaskResumeState['linearPreset']>)
  ) {
    next.linearPreset = input.linearPreset as NonNullable<TaskResumeState['linearPreset']>
  }
  if (
    typeof input.linearMode === 'string' &&
    VALID_LINEAR_MODES.has(input.linearMode as NonNullable<TaskResumeState['linearMode']>)
  ) {
    next.linearMode = input.linearMode as NonNullable<TaskResumeState['linearMode']>
  }
  if (typeof input.linearQuery === 'string') {
    next.linearQuery = input.linearQuery
  }
  if (input.linearContext && typeof input.linearContext === 'object') {
    const context = input.linearContext as Record<string, unknown>
    if (
      (context.kind === 'project' || context.kind === 'view') &&
      typeof context.id === 'string' &&
      context.id.trim() &&
      typeof context.workspaceId === 'string' &&
      context.workspaceId.trim() &&
      context.workspaceId !== 'all'
    ) {
      next.linearContext = {
        kind: context.kind,
        id: context.id,
        workspaceId: context.workspaceId,
        model: context.model === 'issue' || context.model === 'project' ? context.model : undefined
      }
    }
  }
  if (
    typeof input.jiraPreset === 'string' &&
    VALID_JIRA_PRESETS.has(input.jiraPreset as NonNullable<TaskResumeState['jiraPreset']>)
  ) {
    next.jiraPreset = input.jiraPreset as NonNullable<TaskResumeState['jiraPreset']>
  }
  if (typeof input.jiraQuery === 'string') {
    next.jiraQuery = input.jiraQuery
  }
  return Object.keys(next).length > 0 ? next : undefined
}

export function mergeFeatureInteractionState(
  current: FeatureInteractionState,
  incoming: PersistedUIState['featureInteractions']
): FeatureInteractionState {
  const currentNormalized = normalizeFeatureInteractions(current)
  const incomingNormalized = normalizeFeatureInteractions(incoming)
  const merged: FeatureInteractionState = { ...currentNormalized }
  for (const [id, incomingRecord] of Object.entries(incomingNormalized)) {
    const currentRecord = currentNormalized[id as keyof FeatureInteractionState]
    merged[id as keyof FeatureInteractionState] = currentRecord
      ? {
          firstInteractedAt: Math.min(
            currentRecord.firstInteractedAt,
            incomingRecord.firstInteractedAt
          ),
          interactionCount: Math.max(
            currentRecord.interactionCount,
            incomingRecord.interactionCount
          )
        }
      : incomingRecord
  }
  return merged
}

export function mergeContextualTourSeenIds(
  current: readonly ContextualTourId[],
  incoming: PersistedUIState['contextualToursSeenIds']
): ContextualTourId[] {
  const merged = new Set<ContextualTourId>(normalizeContextualTourIds(current))
  for (const id of normalizeContextualTourIds(incoming)) {
    merged.add(id)
  }
  return [...merged]
}

/** One-shot notices: only an explicit true counts as seen or dismissed. */
export function hydrateOneShotNoticesSeen(
  ui: PersistedUIState
): Pick<
  UISlice,
  | 'usageEmptyStateDismissed'
  | 'pluginsAlphaNoticeDismissed'
  | 'codexTerminalServerIsolationNoticeSeen'
  | 'codexSharedSettingsNoticeSeen'
  | 'worktreeCardsUpdateNoticeSeen'
  | 'worktreeCardsIntroNoticeSeen'
  | 'claudeDiffPanelNoticeSeen'
> {
  return {
    // Default false so existing users still see the usage CTA.
    usageEmptyStateDismissed: ui.usageEmptyStateDismissed === true,
    pluginsAlphaNoticeDismissed: ui.pluginsAlphaNoticeDismissed === true,
    codexTerminalServerIsolationNoticeSeen: ui.codexTerminalServerIsolationNoticeSeen === true,
    codexSharedSettingsNoticeSeen: ui.codexSharedSettingsNoticeSeen === true,
    worktreeCardsUpdateNoticeSeen: ui.worktreeCardsUpdateNoticeSeen === true,
    worktreeCardsIntroNoticeSeen: ui.worktreeCardsIntroNoticeSeen === true,
    claudeDiffPanelNoticeSeen: ui.claudeDiffPanelNoticeSeen === true
  }
}

/** Stale acks/marks/cutoffs are inert (paneKey reuse beats them via stateStartedAt); the sanitizers only bound growth. */
export function hydrateAgentReadState(
  ui: PersistedUIState
): Pick<
  UISlice,
  'acknowledgedAgentsByPaneKey' | 'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey'
> {
  return {
    acknowledgedAgentsByPaneKey: sanitizePaneKeyTimestampRecord(ui.acknowledgedAgentsByPaneKey),
    activityClearedAtByPaneKey: sanitizePaneKeyTimestampRecord(ui.activityClearedAtByPaneKey),
    manuallyUnreadTurnsByPaneKey: sanitizePaneKeyTimestampRecord(ui.manuallyUnreadTurnsByPaneKey)
  }
}

/** Tag-section order; a host that predates it sends neither field. */
export function hydrateTagOrder(
  ui: PersistedUIState
): Pick<UISlice, 'tagOrderBy' | 'manualTagOrder'> {
  return {
    tagOrderBy: ui.tagOrderBy ?? 'name',
    manualTagOrder: normalizeManualTagOrder(ui.manualTagOrder)
  }
}

/** The persisted pet when this build or a saved custom pet still has it, else the default. */
export function resolveHydratedPetId(
  petId: unknown,
  customPets: readonly { id: string }[]
): string {
  if (typeof petId !== 'string') {
    return DEFAULT_PET_ID
  }
  if (isBundledPetId(petId) || customPets.some((pet) => pet.id === petId)) {
    return petId
  }
  return DEFAULT_PET_ID
}
