import { normalizeAutoRenameBranchFromWorkDefaultOn } from '../../../../shared/auto-rename-branch-from-work-settings'
import {
  getDefaultSettings,
  normalizeAgentActivityDisplayMode,
  normalizeWorktreeCardProperties
} from '../../../../shared/constants'
import { normalizeContextualTourIds } from '../../../../shared/contextual-tours'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import { normalizeFeatureInteractions } from '../../../../shared/feature-interactions'
import type {
  FeatureInteractionId,
  FeatureInteractionState
} from '../../../../shared/feature-interactions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PairedUiState, PairingLocalUiField } from '../../../../shared/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { normalizeStatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { normalizeTerminalCustomThemes } from '../../../../shared/terminal-custom-themes'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../../shared/tui-agent-launch-defaults'
import { normalizeDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { normalizeUiLanguage } from '../../../../shared/ui-language'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { mergeWorkspaceCleanupUIState } from '../../../../shared/workspace-cleanup-ui-state'

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
    )
  }
}

export function mergeHostWebUIState(
  local: PersistedUIState,
  incoming: PairedUiState
): PersistedUIState {
  // Why `satisfies Record<...>` rather than a `Pick<...>` annotation: every member is optional in
  // PersistedUIState, so Pick would accept a literal that silently skipped a newly added member.
  const pinned = {
    automationHostFilter: local.automationHostFilter,
    hideWorkspacesFromOtherDevices: local.hideWorkspacesFromOtherDevices === true,
    manualRepoOrder: local.manualRepoOrder,
    workspaceHostOrder: local.workspaceHostOrder
  } satisfies Record<PairingLocalUiField, unknown> & Partial<PersistedUIState>
  return { ...mergeWebUIState(local, incoming), ...pinned }
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

export function mergeSettings(
  base: GlobalSettings,
  updates: Partial<GlobalSettings>,
  options: { preserveAutoRenameBranchFromWorkUpdate?: boolean } = {}
): GlobalSettings {
  const defaults = getDefaultSettings('~')
  const merged = {
    ...base,
    ...updates,
    notifications: {
      ...base.notifications,
      ...updates.notifications
    },
    githubProjects: {
      ...(base.githubProjects ?? defaults.githubProjects),
      ...updates.githubProjects
    } as GlobalSettings['githubProjects'],
    disabledTuiAgents: normalizeDisabledTuiAgents(
      updates.disabledTuiAgents ?? base.disabledTuiAgents
    ),
    agentDefaultArgs: normalizeTuiAgentArgsRecord(
      updates.agentDefaultArgs ?? base.agentDefaultArgs
    ),
    agentDefaultEnv: normalizeTuiAgentEnvRecord(updates.agentDefaultEnv ?? base.agentDefaultEnv),
    voice: {
      ...(base.voice ?? defaults.voice),
      ...updates.voice
    } as NonNullable<GlobalSettings['voice']>,
    activeRuntimeEnvironmentId: Object.hasOwn(updates, 'activeRuntimeEnvironmentId')
      ? (updates.activeRuntimeEnvironmentId ?? null)
      : (base.activeRuntimeEnvironmentId ?? null),
    terminalCustomThemes: normalizeTerminalCustomThemes(
      updates.terminalCustomThemes ?? base.terminalCustomThemes
    ),
    uiLanguage: normalizeUiLanguage(updates.uiLanguage ?? base.uiLanguage)
  }
  return {
    ...merged,
    ...normalizeAutoRenameBranchFromWorkDefaultOn(merged, {
      preserveExplicitValue: options.preserveAutoRenameBranchFromWorkUpdate
    })
  }
}
