import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { StructuredAgentLaunchPersistedRecord } from './structured-agent-session-launch-record'

export function desktopCreateWorktreeKey(hostId: ExecutionHostId, worktreeId: string): string {
  return `desktop-worktree:${hostId}:${worktreeId}`
}

export function desktopCreateIdentityKey(hostId: ExecutionHostId, instanceId: string): string {
  return `desktop-create:${hostId}:${instanceId}`
}

export function launchRecordKeys(record: StructuredAgentLaunchPersistedRecord): string[] {
  const params = record.desktopCreate?.params
  return [
    record.sessionId,
    ...(record.desktopCreate?.worktreeId
      ? [desktopCreateWorktreeKey(record.executionHostId, record.desktopCreate.worktreeId)]
      : []),
    ...(params?.createIdentity
      ? [
          desktopCreateIdentityKey(record.executionHostId, params.createIdentity.instanceId),
          `desktop-pane:${record.executionHostId}:${params.paneKey}`,
          `desktop-tab:${record.executionHostId}:${parsePaneKey(params.paneKey ?? '')?.tabId}`
        ]
      : [])
  ]
}

export function launchRecordSlotIds(
  records: readonly StructuredAgentLaunchPersistedRecord[],
  worktreeId: string,
  groupId?: string
): Set<string> {
  return new Set(
    records.flatMap((record) =>
      record.executionHostId === 'local' &&
      record.lifecycle !== 'failed' &&
      record.surfaceAddress?.worktreeId === worktreeId &&
      (!groupId || record.surfaceAddress.targetGroupId === groupId)
        ? [structuredAgentSessionTabId(record.sessionId)]
        : []
    )
  )
}
