// Shared categorization of recovery-card action ids by how a container dispatches
// them, so the interactive (above-terminal) and background (sidebar) recovery
// cards route identical actions the same way instead of drifting apart.

import type { AgentLaunchRecoveryActionId } from '@/lib/agent-launch-recovery-card'

/** Retry-family actions all resolve to a `retry-same` launch against the pinned
 *  identity; the distinct labels (`agent_configuration_changed`,
 *  `invalid_launch_snapshot`) are copy-only adoptions, not different requests. */
export const RETRY_SAME_ACTIONS: ReadonlySet<AgentLaunchRecoveryActionId> = new Set([
  'retry',
  'retry-current-settings',
  'launch-current-settings'
])

/** Actions whose recovery entry is the desktop-host agents settings pane. */
export const AGENTS_SETTINGS_ACTIONS: ReadonlySet<AgentLaunchRecoveryActionId> = new Set([
  'choose-agent',
  'edit-agent-settings',
  'repair-on-host',
  'manage-agents'
])
