import { isAgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import { normalizeNativeChatAppearanceSettings } from '../../../../shared/native-chat/native-chat-appearance-settings'
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
  DEFAULT_TUI_AGENT_ARGS,
  DEFAULT_TUI_AGENT_ENV,
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../../shared/tui-agent-launch-defaults'
import { hasTypedAgentPermission } from '../../../../shared/tui-agent-permission-choice'
import { migrateAgentPermissionChoice } from '../../../../shared/tui-agent-permission-lift'
import { normalizeOsc52ClipboardDefaultOn } from '../../../../shared/osc52-clipboard-settings'
import { normalizeTerminalCursorStyleDefault } from '../../../../shared/terminal-cursor-style-settings'
import { normalizeDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { normalizeUiLanguage } from '../../../../shared/ui-language'
import { migratePortugueseUiLanguageOnLoad } from '../../../../shared/portuguese-ui-language-migration'
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
  // All PersistedUIState members are optional; satisfies Record catches newly omitted keys that Pick would accept.
  const pinned = {
    automationHostFilter: local.automationHostFilter,
    hideWorkspacesFromOtherDevices: local.hideWorkspacesFromOtherDevices === true,
    manualRepoOrder: local.manualRepoOrder,
    workspaceHostOrder: local.workspaceHostOrder,
    sidebarOpen: local.sidebarOpen,
    agentsVisibleHostIds: local.agentsVisibleHostIds,
    agentsFilterRepoIds: local.agentsFilterRepoIds,
    agentsHideWorkspacesFromOtherDevices: local.agentsHideWorkspacesFromOtherDevices === true,
    agentsHideAutomationGeneratedWorkspaces: local.agentsHideAutomationGeneratedWorkspaces === true,
    agentsHideCliCreatedWorkspaces: local.agentsHideCliCreatedWorkspaces === true,
    agentsShowChildAgents: local.agentsShowChildAgents,
    agentsCompactMode: local.agentsCompactMode,
    agentsShowSearch: local.agentsShowSearch,
    agentsReadFilter: local.agentsReadFilter,
    agentsGroupBy: local.agentsGroupBy,
    activityClearedAtByPaneKey: local.activityClearedAtByPaneKey,
    manuallyUnreadTurnsByPaneKey: local.manuallyUnreadTurnsByPaneKey
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

/** A browser-saved settings blob with each load-time migration applied. */
export function migrateStoredWebSettings(stored: Partial<GlobalSettings>): Partial<GlobalSettings> {
  return {
    ...stored,
    ...migrateBrowserSavedAgentPermission(stored),
    ...normalizeAutoRenameBranchFromWorkDefaultOn(stored),
    ...normalizeTerminalCursorStyleDefault(stored),
    ...normalizeOsc52ClipboardDefaultOn(stored),
    terminalCustomThemes: normalizeTerminalCustomThemes(stored.terminalCustomThemes),
    ...migratePortugueseUiLanguageOnLoad(stored)
  }
}

/** Move legacy browser-saved permission flags so stored defaults cannot duplicate them; missing keys used the shipped default. */
function migrateBrowserSavedAgentPermission(stored: Partial<GlobalSettings>) {
  if (hasTypedAgentPermission(stored) || (!stored.agentDefaultArgs && !stored.agentDefaultEnv)) {
    return {}
  }
  return migrateAgentPermissionChoice(
    {
      agentDefaultArgs: { ...DEFAULT_TUI_AGENT_ARGS, ...stored.agentDefaultArgs },
      agentDefaultEnv: { ...DEFAULT_TUI_AGENT_ENV, ...stored.agentDefaultEnv }
    },
    null
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
      // Why: browser-stored settings can predate a newer notification field.
      ...defaults.notifications,
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
    nativeChatAppearance: normalizeNativeChatAppearanceSettings(
      Object.hasOwn(updates, 'nativeChatAppearance')
        ? updates.nativeChatAppearance
        : base.nativeChatAppearance
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

/** The host's new-chat permission default (the host seeds from it), kept only when a known mode. */
export function runtimeChatPermissionSetting(
  settings: Partial<GlobalSettings>,
  _includeAgentOverrides = true
): Pick<GlobalSettings, 'nativeChatPermissionMode'> {
  return isAgentChatPermissionMode(settings.nativeChatPermissionMode)
    ? { nativeChatPermissionMode: settings.nativeChatPermissionMode }
    : {}
}
