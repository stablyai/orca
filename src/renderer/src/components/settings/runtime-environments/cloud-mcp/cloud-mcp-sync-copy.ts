import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  McpSyncServerRow,
  McpSyncStatus
} from '../../../../../../shared/agent-mcp-sync/mcp-sync-contract'

export function mcpSyncCounts(status: McpSyncStatus): { synced: number; skipped: number } {
  const synced = status.rows.filter((row) => row.state === 'synced').length
  return { synced, skipped: status.rows.length - synced }
}

/** One-line summary for the row header and the host menu. */
export function mcpSyncSummary(status: McpSyncStatus, t: Translate = translate): string {
  if (status.running) {
    return t('cloudMcpSync.summary.syncing', 'Syncing…')
  }
  if (status.rows.length === 0) {
    return t('cloudMcpSync.summary.none', 'None on this computer')
  }
  if (status.lastSyncedAt === null) {
    return t('cloudMcpSync.summary.notSynced', '{{count}} found, not synced yet', {
      count: status.rows.length
    })
  }
  const { synced, skipped } = mcpSyncCounts(status)
  return skipped === 0
    ? t('cloudMcpSync.summary.synced', '{{synced}} synced', { synced })
    : t('cloudMcpSync.summary.syncedSkipped', '{{synced}} synced, {{skipped}} skipped', {
        synced,
        skipped
      })
}

export function mcpSyncErrorText(
  error: McpSyncStatus['error'],
  t: Translate = translate
): string | null {
  switch (error) {
    case 'host-outdated':
      return t(
        'cloudMcpSync.error.hostOutdated',
        'This workspace runs an older Orca server that can’t receive MCP servers yet.'
      )
    case 'host-unreachable':
      return t('cloudMcpSync.error.hostUnreachable', 'Orca couldn’t reach this workspace.')
    case 'failed':
      return t('cloudMcpSync.error.failed', 'The last sync didn’t finish.')
    default:
      return null
  }
}

/** Why a server is not running in the workspace, or a caveat for one that is. */
export function mcpSyncRowNote(row: McpSyncServerRow, t: Translate = translate): string | null {
  if (row.state === 'synced') {
    return row.unreachable
      ? t(
          'cloudMcpSync.row.unreachable',
          'Synced, but the workspace can’t reach this host. Its network may block it.'
        )
      : null
  }
  switch (row.outcome ?? row.skipReason) {
    case 'turned-off':
      return t('cloudMcpSync.row.turnedOff', 'Off for cloud workspaces')
    case 'in-repo':
      return t('cloudMcpSync.row.inRepo', 'Comes from the repo’s .mcp.json')
    case 'local-command':
      return t('cloudMcpSync.row.localCommand', 'Its command only exists on this computer')
    case 'local-path':
      return t('cloudMcpSync.row.localPath', 'Uses files on this computer')
    case 'local-url':
      return t('cloudMcpSync.row.localUrl', 'Runs on this computer’s localhost')
    case 'command-missing':
      return t('cloudMcpSync.row.commandMissing', '{{command}} isn’t installed in the workspace', {
        command: row.target ?? ''
      })
    case 'kept-host':
      return t('cloudMcpSync.row.keptHost', 'Already set up in the workspace; left as is')
    case 'config-unreadable':
      return t(
        'cloudMcpSync.row.configUnreadable',
        'The agent’s config in the workspace couldn’t be updated'
      )
    case 'invalid':
      return t('cloudMcpSync.row.invalid', 'Invalid server entry')
    default:
      return row.state === 'pending' ? t('cloudMcpSync.row.pending', 'Not synced yet') : null
  }
}
