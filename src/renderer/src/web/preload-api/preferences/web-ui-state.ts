import { normalizeAgentActivityDisplayMode } from '../../../../../shared/agent-status/presentation/agent-activity-display-mode'
import {
  normalizeWorktreeCardProperties,
  getWorktreeCardModeProperties
} from '../../../../../shared/worktree/row-display/card-properties'
import {
  normalizeContextualTourIds,
  type ContextualTourId
} from '../../../../../shared/feature-education/contextual-tours/contextual-tours'

import {
  normalizeFeatureInteractions,
  type FeatureInteractionState
} from '../../../../../shared/feature-education/interactions/feature-interactions'
import type { FeatureInteractionId } from '../../../../../shared/feature-education/interactions/feature-interaction-catalog'
import type {
  PairedUiState,
  PairingLocalUiField
} from '../../../../../shared/remote-runtime/pairing/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import { normalizeStatusBarUsageMode } from '../../../../../shared/status-bar/status-bar-usage-mode'
import { normalizeStatusBarUsageFormat } from '../../../../../shared/status-bar/status-bar-usage-format'
import { normalizeUsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { mergeWorkspaceCleanupUIState } from '../../../../../shared/workspace-cleanup/workspace-cleanup-ui-state'
import { getDefaultUIState } from '../../../../../shared/orca-profiles/constants'
import { pinnedBotUiState } from './paired-bot-ui-state'
import { getStoredSettings } from './web-preferences-store'
import { UI_STORAGE_KEY, readJson } from '../web-storage'

export function mergeWebUIState(
  base: PersistedUIState,
  updates: Partial<PersistedUIState>
): PersistedUIState {
  const { featureInteractionTelemetryBuckets: _reserved, ...safeUpdates } =
    updates as Partial<PersistedUIState> & {
      featureInteractionTelemetryBuckets?: unknown
    }
  void _reserved
  return {
    ...base,
    ...safeUpdates,
    workspaceCleanup: mergeWorkspaceCleanupUIState(
      base.workspaceCleanup,
      safeUpdates.workspaceCleanup
    ),
    worktreeCardProperties: normalizeWorktreeCardProperties(
      safeUpdates.worktreeCardProperties ?? base.worktreeCardProperties
    ),
    _worktreeCardModeDefaulted:
      safeUpdates._worktreeCardModeDefaulted ?? base._worktreeCardModeDefaulted,
    agentActivityDisplayMode: normalizeAgentActivityDisplayMode(
      safeUpdates.agentActivityDisplayMode ?? base.agentActivityDisplayMode
    ),
    usagePercentageDisplay: normalizeUsagePercentageDisplay(
      safeUpdates.usagePercentageDisplay ?? base.usagePercentageDisplay
    ),
    statusBarUsageMode: normalizeStatusBarUsageMode(
      safeUpdates.statusBarUsageMode ?? base.statusBarUsageMode
    ),
    statusBarUsageFormat: normalizeStatusBarUsageFormat(
      safeUpdates.statusBarUsageFormat ?? base.statusBarUsageFormat
    )
  }
}

export function mergeHostWebUIState(
  local: PersistedUIState,
  incoming: PairedUiState
): PersistedUIState {
  // All PersistedUIState members are optional; satisfies Record catches newly omitted keys that Pick would accept.
  const pinned = {
    automationHostFilter: local.automationHostFilter,
    hideWorkspacesFromOtherDevices: local.hideWorkspacesFromOtherDevices === true,
    manualRepoOrder: local.manualRepoOrder,
    workspaceHostOrder: local.workspaceHostOrder,
    sidebarOpen: local.sidebarOpen,
    activityBarPosition: local.activityBarPosition,
    activityBarOrder: local.activityBarOrder,
    activityBarBotOrder: local.activityBarBotOrder,
    activityBarHidden: local.activityBarHidden,
    showAgentModels: local.showAgentModels !== false,
    agentsVisibleHostIds: local.agentsVisibleHostIds,
    agentsFilterRepoIds: local.agentsFilterRepoIds,
    agentsHideWorkspacesFromOtherDevices: local.agentsHideWorkspacesFromOtherDevices === true,
    agentsHideAutomationGeneratedWorkspaces: local.agentsHideAutomationGeneratedWorkspaces === true,
    agentsHideCliCreatedWorkspaces: local.agentsHideCliCreatedWorkspaces === true,
    ...pinnedBotUiState(local),
    agentsShowChildAgents: local.agentsShowChildAgents,
    agentsCompactMode: local.agentsCompactMode,
    agentsShowSearch: local.agentsShowSearch,
    agentsReadFilter: local.agentsReadFilter,
    agentsGroupBy: local.agentsGroupBy,
    activityClearedAtByPaneKey: local.activityClearedAtByPaneKey,
    manuallyUnreadTurnsByPaneKey: local.manuallyUnreadTurnsByPaneKey,
    wslMovedSectionCollapsed: local.wslMovedSectionCollapsed,
    hiddenWslMovedProjectKeys: local.hiddenWslMovedProjectKeys
  } satisfies Record<PairingLocalUiField, unknown> & Partial<PersistedUIState>
  return {
    ...mergeWebUIState(local, incoming),
    ...pinned,
    // Old hosts omit this field; a cached arm must not make their strict ui.set reject mode changes.
    statusBarCompactChangeNoticeDismissed: incoming.statusBarCompactChangeNoticeDismissed !== false
  }
}

export function mergeFeatureInteractionState(
  current: PersistedUIState['featureInteractions'],
  incoming: PersistedUIState['featureInteractions']
): FeatureInteractionState {
  const currentNormalized = normalizeFeatureInteractions(current)
  const incomingNormalized = normalizeFeatureInteractions(incoming)
  const merged: FeatureInteractionState = { ...currentNormalized }
  for (const [id, incomingRecord] of Object.entries(incomingNormalized)) {
    const featureId = id as FeatureInteractionId
    const currentRecord = currentNormalized[featureId]
    merged[featureId] = currentRecord
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
  current: PersistedUIState['contextualToursSeenIds'],
  incoming: PersistedUIState['contextualToursSeenIds']
): ContextualTourId[] {
  const merged = new Set<ContextualTourId>(normalizeContextualTourIds(current))
  for (const id of normalizeContextualTourIds(incoming)) {
    merged.add(id)
  }
  return [...merged]
}

export function mergeOsc52ClipboardNoticePending(
  current: PersistedUIState,
  incoming: PersistedUIState
): boolean {
  return (
    current.osc52ClipboardDefaultOnNoticePending === true ||
    incoming.osc52ClipboardDefaultOnNoticePending === true
  )
}

export function readLocalWebUIState(): PersistedUIState {
  const defaults = getDefaultUIState()
  // Settings migration arms OSC 52’s UI notice; reading UI first would later overwrite that arm after its one-shot stamp.
  const storedSettings = getStoredSettings()
  const stored = readJson<Partial<PersistedUIState>>(UI_STORAGE_KEY, {})
  const base = {
    ...defaults,
    // Why: mirror the main-process missing-property seed from legacy card layout mode when runtime ui.get is unavailable.
    worktreeCardProperties: getWorktreeCardModeProperties(
      storedSettings.compactWorktreeCards ? 'Compact' : 'Default'
    )
  }
  if (typeof stored.rightSidebarOpen === 'boolean') {
    return mergeWebUIState(base, stored)
  }
  return mergeWebUIState(base, {
    ...stored,
    // Why: web fallback lacks main-process normalization; migrate the retired setting only when local UI preference is absent.
    rightSidebarOpen: storedSettings.rightSidebarOpenByDefault
  })
}
