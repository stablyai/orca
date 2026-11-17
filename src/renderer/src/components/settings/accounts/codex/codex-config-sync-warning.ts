import type {
  CodexConfigSyncStallReason,
  CodexConfigSyncStatus
} from '../../../../../../shared/agent-accounts/codex/codex-config-sync-types'

/** Keep stall reasons machine-readable so warning copy is localized at the component. */
export function getCodexConfigSyncWarning(
  status: CodexConfigSyncStatus | null | undefined
): CodexConfigSyncStallReason | null {
  return status && status.state === 'stalled' ? status.reason : null
}
