import type { AppState } from '../../types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { pruneMigrationUnsupportedEntries } from './agent-status-migration-unsupported-entries'
import { removePaneKeys } from './agent-status-pane-keyed-records'

export function isSleepingAgentStatus(row: AgentStatusEntry | undefined, ptyId?: string): boolean {
  return Boolean(
    row?.state === 'done' &&
    row.paneSleep &&
    // Paired IDs name terminal handles; the source already validated its physical PTY.
    (!ptyId || isRemoteRuntimePtyId(ptyId) || row.paneSleep.ptyId === ptyId)
  )
}

export function agentProcessRetirementPatch(state: AppState, paneKey: string) {
  const agentLaunchConfigByPaneKey = removePaneKeys(
    state.agentLaunchConfigByPaneKey,
    new Set([paneKey])
  )
  const migration = pruneMigrationUnsupportedEntries(
    state.migrationUnsupportedByPtyId,
    (entry) => entry.paneKey === paneKey
  )
  return {
    changed: agentLaunchConfigByPaneKey !== state.agentLaunchConfigByPaneKey || migration.changed,
    patch: {
      agentLaunchConfigByPaneKey,
      migrationUnsupportedByPtyId: migration.next
    }
  }
}
