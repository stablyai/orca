import { getIntlLocale, translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  McpSyncHostOutcome,
  McpSyncServerRow,
  McpSyncSkipReason,
  McpSyncStatus
} from '../../../../../../shared/agent-mcp-sync/mcp-sync-contract'

export function mcpSyncCounts(status: McpSyncStatus): { synced: number; skipped: number } {
  const synced = status.rows.filter((row) => row.state === 'synced').length
  return { synced, skipped: status.rows.length - synced }
}

/** Time today, date and time otherwise, in the app's UI language. */
export function mcpSyncTimeLabel(at: number, now: number = Date.now()): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return new Date(at).toLocaleString(
    getIntlLocale(),
    sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  )
}

/** One-line summary for the panel header and the host menu; counts stay put while a sync runs. */
export function mcpSyncSummary(status: McpSyncStatus, t: Translate = translate): string {
  if (status.rows.length === 0) {
    return t(
      'cloudMcpSync.summary.none',
      'None found in Claude Code or Codex on this computer. Servers you add there show up here.'
    )
  }
  if (status.error === 'host-outdated' && status.lastSyncedAt === null) {
    return t('cloudMcpSync.summary.found', '{{count}} found', {
      count: status.rows.length,
      defaultValue_one: '{{count}} found'
    })
  }
  if (status.lastSyncedAt === null) {
    return t('cloudMcpSync.summary.notSynced', '{{count}} found, not synced yet', {
      count: status.rows.length,
      defaultValue_one: '{{count}} found, not synced yet'
    })
  }
  const counts = mcpSyncCounts(status)
  const synced = t('cloudMcpSync.summary.synced', '{{count}} synced', {
    count: counts.synced,
    defaultValue_one: '{{count}} synced'
  })
  if (counts.skipped === 0) {
    return synced
  }
  const skipped = t('cloudMcpSync.summary.skipped', '{{count}} skipped', {
    count: counts.skipped,
    defaultValue_one: '{{count}} skipped'
  })
  return t('cloudMcpSync.summary.pair', '{{synced}}, {{skipped}}', { synced, skipped })
}

/** Errors the user can retry; an outdated sandbox needs a new workspace, not another try. */
export function mcpSyncErrorRetryable(error: McpSyncStatus['error']): boolean {
  return error === 'host-unreachable' || error === 'failed'
}

export function mcpSyncErrorText(
  error: McpSyncStatus['error'],
  t: Translate = translate
): string | null {
  const copy: Record<NonNullable<McpSyncStatus['error']>, string> = {
    'host-outdated': t(
      'cloudMcpSync.error.hostOutdated',
      'This sandbox’s Orca is too old for MCP servers. Create a new workspace to use them.'
    ),
    'host-unreachable': t(
      'cloudMcpSync.error.hostUnreachable',
      'Couldn’t reach the sandbox. Servers already in the sandbox still work.'
    ),
    failed: t(
      'cloudMcpSync.error.failed',
      'The last sync didn’t finish. Servers already in the sandbox still work.'
    )
  }
  return error ? copy[error] : null
}

type RowNoteKey = Exclude<McpSyncSkipReason, 'turned-off'> | McpSyncHostOutcome

/** Why a server is not running in the sandbox, or a caveat for one that is. */
export function mcpSyncRowNote(row: McpSyncServerRow, t: Translate = translate): string | null {
  if (row.state === 'synced') {
    return row.unreachable
      ? t(
          'cloudMcpSync.row.unreachable',
          'Synced, but the sandbox can’t reach this server. Sync now to reopen its host.'
        )
      : null
  }
  if (row.state === 'pending') {
    // The dashed icon and the header already say nothing has synced; a note per row is noise.
    return null
  }
  const notes: Partial<Record<RowNoteKey, string>> = {
    'in-repo': t(
      'cloudMcpSync.row.inRepo',
      'Comes from the repo’s .mcp.json, so the sandbox already has it'
    ),
    'local-command': t('cloudMcpSync.row.localCommand', 'Command exists only on this computer'),
    'local-path': t('cloudMcpSync.row.localPath', 'Uses files on this computer'),
    'local-url': t('cloudMcpSync.row.localUrl', 'Runs on this computer’s localhost'),
    invalid: t('cloudMcpSync.row.invalid', 'Invalid server entry'),
    'command-missing': t(
      'cloudMcpSync.row.commandMissing',
      'Will sync once {{command}} is installed in the sandbox',
      { command: row.target ?? '' }
    ),
    'kept-host': t('cloudMcpSync.row.keptHost', 'The sandbox already has its own {{name}} server', {
      name: row.name
    }),
    'config-unreadable': t(
      'cloudMcpSync.row.configUnreadable',
      'Couldn’t update the agent’s config in the sandbox'
    )
  }
  const key = row.outcome ?? row.skipReason
  // A turned-off row's switch already says so.
  return key && key !== 'turned-off' ? (notes[key] ?? null) : null
}

// Skips a toggle can't change: the server can't (or needn't) come from this computer.
const FIXED_SKIPS: ReadonlySet<string> = new Set([
  'in-repo',
  'local-command',
  'local-path',
  'local-url',
  'invalid',
  'kept-host'
])

export function mcpSyncRowToggleable(row: McpSyncServerRow): boolean {
  const key = row.outcome ?? row.skipReason
  return !key || !FIXED_SKIPS.has(key)
}

/** Synced first, then rows a switch can change, then skips nothing here can fix. */
export function mcpSyncSortRows(rows: readonly McpSyncServerRow[]): McpSyncServerRow[] {
  const rank = (row: McpSyncServerRow): number =>
    row.state === 'synced' ? 0 : mcpSyncRowToggleable(row) ? 1 : 2
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row)
}

/** What the row's icon says, for screen readers. */
export function mcpSyncRowStateLabel(row: McpSyncServerRow, t: Translate = translate): string {
  if (row.state === 'synced') {
    return row.unreachable
      ? t('cloudMcpSync.state.unreachable', 'Synced, not reachable')
      : t('cloudMcpSync.state.synced', 'Synced')
  }
  return row.state === 'pending' && row.included
    ? t('cloudMcpSync.state.pending', 'Not synced yet')
    : t('cloudMcpSync.state.skipped', 'Not synced')
}
