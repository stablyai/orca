import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import type {
  StatusBarItem,
  TaskResumeState,
  TaskViewPresetId
} from '../../../../../shared/ui-chrome-types'
import type { FeatureInteractionState } from '../../../../../shared/feature-interactions'
import type { ContextualTourId } from '../../../../../shared/contextual-tours'
import { normalizeFeatureInteractions } from '../../../../../shared/feature-interactions'
import { normalizeContextualTourIds } from '../../../../../shared/contextual-tours'
import type { UISlice } from './ui-slice-contract'
import {
  migrateStatusBarItems,
  sanitizeAcknowledgedAgentsByPaneKey,
  sanitizeActivityClearedAtByPaneKey,
  sanitizePaneKeyTimestampRecord
} from './ui-slice-hydration-sanitizers'

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

const DEFAULT_ON_PORTS_STATUS_BAR_ITEM: StatusBarItem = 'ports'
const DEFAULT_ON_KIMI_STATUS_BAR_ITEM: StatusBarItem = 'kimi'
const DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM: StatusBarItem = 'minimax'
const DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM: StatusBarItem = 'antigravity'
const DEFAULT_ON_GROK_STATUS_BAR_ITEM: StatusBarItem = 'grok'

export function hydrateStatusBarItems(ui: PersistedUIState): StatusBarItem[] {
  let items = migrateStatusBarItems(ui.statusBarItems)
  const defaults = [
    ['_portsStatusBarDefaultAdded', DEFAULT_ON_PORTS_STATUS_BAR_ITEM],
    ['_kimiStatusBarDefaultAdded', DEFAULT_ON_KIMI_STATUS_BAR_ITEM],
    ['_minimaxStatusBarDefaultAdded', DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM],
    ['_antigravityStatusBarDefaultAdded', DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM],
    ['_grokStatusBarDefaultAdded', DEFAULT_ON_GROK_STATUS_BAR_ITEM]
  ] as const
  for (const [flag, item] of defaults) {
    if (!ui[flag] && !items.includes(item)) {
      items = [...items, item]
    }
  }
  if (typeof window !== 'undefined' && defaults.some(([flag]) => !ui[flag])) {
    window.api.ui
      .set({ statusBarItems: items, ...Object.fromEntries(defaults.map(([flag]) => [flag, true])) })
      .catch(console.error)
  }
  return items
}

/** Stale acks/marks are inert (paneKey reuse beats them via stateStartedAt); the sanitizers only bound growth past HYDRATE_MAX_AGE_MS. */
export function hydrateAgentReadState(
  ui: PersistedUIState
): Pick<
  UISlice,
  'acknowledgedAgentsByPaneKey' | 'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey'
> {
  return {
    acknowledgedAgentsByPaneKey: sanitizeAcknowledgedAgentsByPaneKey(
      ui.acknowledgedAgentsByPaneKey
    ),
    activityClearedAtByPaneKey: sanitizeActivityClearedAtByPaneKey(ui.activityClearedAtByPaneKey),
    manuallyUnreadTurnsByPaneKey: sanitizePaneKeyTimestampRecord(ui.manuallyUnreadTurnsByPaneKey)
  }
}
