import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  agentOfKind,
  isSkillKind,
  type AgentConfigSyncRow,
  type AgentConfigSyncStatus
} from '../../../../../../shared/agent-config-sync/agent-config-sync-contract'

// Glossary: the agent is "Claude" in UI copy, never "Claude Code".
export const AGENT_LABEL = { claude: 'Claude', codex: 'Codex' } as const

/** What the user types: `/frontend:review` for a namespaced Claude command, `/prompts:x` in Codex. */
export function cloudSkillsDisplayName(row: Pick<AgentConfigSyncRow, 'kind' | 'name'>): string {
  if (row.kind === 'claude-command') {
    return `/${row.name.split('/').join(':')}`
  }
  if (row.kind === 'codex-prompt') {
    return `/prompts:${row.name}`
  }
  return row.name
}

export function cloudSkillsKindLabel(row: AgentConfigSyncRow, t: Translate = translate): string {
  const agent = AGENT_LABEL[agentOfKind(row.kind)]
  const kind = isSkillKind(row.kind)
    ? t('cloudSkillsSync.kind.skill', '{{agent}} skill', { agent })
    : row.kind === 'codex-prompt'
      ? t('cloudSkillsSync.kind.prompt', 'Codex prompt')
      : t('cloudSkillsSync.kind.command', '{{agent}} command', { agent })
  return row.scope === 'project'
    ? t('cloudSkillsSync.kind.project', '{{kind}}, this project', { kind })
    : kind
}

/** Rows the user's switches apply to: a copy for the other agent follows its original. */
export function cloudSkillsRowIncluded(
  row: AgentConfigSyncRow,
  excluded: ReadonlySet<string>
): boolean {
  return !excluded.has(row.convertedFrom ?? row.key)
}

export function cloudSkillsCounts(status: AgentConfigSyncStatus): {
  synced: number
  skipped: number
} {
  const synced = status.rows.filter((row) => row.state === 'synced').length
  return { synced, skipped: status.rows.length - synced }
}

export function cloudSkillsSummary(
  status: AgentConfigSyncStatus,
  t: Translate = translate
): string {
  if (status.rows.length === 0) {
    return t('cloudSkillsSync.summary.none', 'None found in Claude or Codex on this computer')
  }
  if (status.lastSyncedAt === null) {
    return t('cloudSkillsSync.summary.notSynced', '{{count}} found, not synced yet', {
      count: status.rows.length,
      defaultValue_one: '{{count}} found, not synced yet'
    })
  }
  const counts = cloudSkillsCounts(status)
  const synced = t('cloudSkillsSync.summary.synced', '{{count}} synced', {
    count: counts.synced,
    defaultValue_one: '{{count}} synced'
  })
  if (counts.skipped === 0) {
    return synced
  }
  const skipped = t('cloudSkillsSync.summary.skipped', '{{count}} not synced', {
    count: counts.skipped,
    defaultValue_one: '{{count}} not synced'
  })
  return t('cloudSkillsSync.summary.pair', '{{synced}}, {{skipped}}', { synced, skipped })
}

export function cloudSkillsErrorRetryable(error: AgentConfigSyncStatus['error']): boolean {
  return error === 'host-unreachable' || error === 'failed'
}

export function cloudSkillsErrorText(
  error: AgentConfigSyncStatus['error'],
  t: Translate = translate
): string | null {
  const copy: Record<NonNullable<AgentConfigSyncStatus['error']>, string> = {
    'host-outdated': t(
      'cloudSkillsSync.error.hostOutdated',
      'This workspace was created before skills sync. Create a new workspace to use it.'
    ),
    'host-unreachable': t(
      'cloudSkillsSync.error.hostUnreachable',
      'Couldn’t reach the sandbox. Skills already there still work.'
    ),
    failed: t(
      'cloudSkillsSync.error.failed',
      'The last sync didn’t finish. Skills already in the sandbox still work.'
    )
  }
  return error ? copy[error] : null
}

/** Why an item is not in the sandbox, or a caveat for one that is. */
export function cloudSkillsRowNote(
  row: AgentConfigSyncRow,
  t: Translate = translate
): string | null {
  if (row.state === 'synced' && row.withheldFiles > 0) {
    return t(
      'cloudSkillsSync.row.withheld',
      'Synced without {{count}} files that look like keys or credentials',
      {
        count: row.withheldFiles,
        defaultValue_one: 'Synced without 1 file that looks like a key or credential'
      }
    )
  }
  if (row.state !== 'skipped') {
    return row.convertedFrom
      ? t('cloudSkillsSync.row.converted', 'Copied from {{agent}} so both agents have it', {
          agent: AGENT_LABEL[agentOfKind(row.kind) === 'claude' ? 'codex' : 'claude']
        })
      : null
  }
  const key = row.outcome ?? row.skipReason
  switch (key) {
    case 'turned-off':
      return t('cloudSkillsSync.row.turnedOff', 'Turned off')
    case 'in-repo':
      return t('cloudSkillsSync.row.inRepo', 'Committed to the repo, so the sandbox already has it')
    case 'too-large':
      return t('cloudSkillsSync.row.tooLarge', 'Too large to sync (256 KB a file, 512 KB a skill)')
    case 'over-limit':
      return t('cloudSkillsSync.row.overLimit', 'Over the 8 MB a workspace can receive')
    case 'secret':
      return t(
        'cloudSkillsSync.row.secret',
        'Looks like it contains a key or token, so it stays on this computer'
      )
    case 'invalid':
      return t('cloudSkillsSync.row.invalid', 'Its name or files can’t be copied')
    case 'kept-host':
      return t(
        'cloudSkillsSync.row.keptHost',
        'The sandbox has its own {{name}}, so it’s left alone',
        { name: cloudSkillsDisplayName(row) }
      )
    case 'no-project':
      return t('cloudSkillsSync.row.noProject', 'The sandbox has no project checkout for it')
    case 'failed':
      return t('cloudSkillsSync.row.failed', 'Couldn’t write it in the sandbox')
    case 'added':
    case 'updated':
    case 'unchanged':
    case 'needed':
    case undefined:
      return null
  }
}

const FIXED_SKIPS: ReadonlySet<string> = new Set([
  'in-repo',
  'too-large',
  'secret',
  'invalid',
  'kept-host',
  'no-project'
])

/** A copy follows its original's switch; fixed skips can't be changed from here. */
export function cloudSkillsRowToggleable(row: AgentConfigSyncRow): boolean {
  if (row.convertedFrom) {
    return false
  }
  const key = row.outcome ?? row.skipReason
  return !key || !FIXED_SKIPS.has(key)
}

export type CloudSkillsEntry = {
  row: AgentConfigSyncRow
  /** The same skill (same name and content) in the other agent's folder: shown on this row. */
  twins: AgentConfigSyncRow[]
  copies: AgentConfigSyncRow[]
}

/** Rows a group's count covers: the entry, its twins and its copies. */
export function cloudSkillsEntryCount(entries: readonly CloudSkillsEntry[]): number {
  return entries.reduce((sum, entry) => sum + 1 + entry.twins.length + entry.copies.length, 0)
}

/** Keys one row's switch changes: the row and its twins. */
export function cloudSkillsEntryKeys(entry: CloudSkillsEntry): string[] {
  return [entry.row.key, ...entry.twins.map((twin) => twin.key)]
}

/** "Claude skill, Codex skill" for a row that stands for both agents' copies. */
export function cloudSkillsEntryKindLabel(
  entry: CloudSkillsEntry,
  t: Translate = translate
): string {
  return (
    [entry.row, ...entry.twins]
      // Claude first, then Codex, whatever order the folders were read in.
      .sort(
        (a, b) =>
          Number(agentOfKind(a.kind) !== 'claude') - Number(agentOfKind(b.kind) !== 'claude')
      )
      .map((row) => cloudSkillsKindLabel(row, t))
      .join(', ')
  )
}

/** One skill installed for both agents (identical content, same state) reads as one row. */
function mergeTwins(entries: CloudSkillsEntry[]): CloudSkillsEntry[] {
  const merged: CloudSkillsEntry[] = []
  const byKey = new Map<string, CloudSkillsEntry>()
  for (const entry of entries) {
    const { row } = entry
    const twinKey =
      isSkillKind(row.kind) && row.digest
        ? [
            row.scope,
            row.name,
            row.digest,
            row.state,
            row.state === 'synced' ? '' : (row.outcome ?? row.skipReason ?? '')
          ].join('\0')
        : null
    const host = twinKey ? byKey.get(twinKey) : undefined
    if (host && agentOfKind(host.row.kind) !== agentOfKind(row.kind)) {
      host.twins.push(row)
      host.copies.push(...entry.copies)
      continue
    }
    if (twinKey && !host) {
      byKey.set(twinKey, entry)
    }
    merged.push(entry)
  }
  return merged
}
export type CloudSkillsGroups = {
  synced: CloudSkillsEntry[]
  pending: CloudSkillsEntry[]
  notSynced: CloudSkillsEntry[]
}

const byName = (a: AgentConfigSyncRow, b: AgentConfigSyncRow): number =>
  cloudSkillsDisplayName(a).localeCompare(cloudSkillsDisplayName(b)) || a.key.localeCompare(b.key)

/** Synced, ready (never synced yet) and not synced; each copy for the other agent sits under its original. */
export function cloudSkillsGroupRows(rows: readonly AgentConfigSyncRow[]): CloudSkillsGroups {
  const originals = new Set(rows.filter((row) => !row.convertedFrom).map((row) => row.key))
  const copies = new Map<string, AgentConfigSyncRow[]>()
  for (const row of rows) {
    if (row.convertedFrom && originals.has(row.convertedFrom)) {
      copies.set(row.convertedFrom, [...(copies.get(row.convertedFrom) ?? []), row])
    }
  }
  const groups: CloudSkillsGroups = { synced: [], pending: [], notSynced: [] }
  for (const row of [...rows].sort(byName)) {
    if (row.convertedFrom && originals.has(row.convertedFrom)) {
      continue
    }
    const entry: CloudSkillsEntry = {
      row,
      twins: [],
      copies: (copies.get(row.key) ?? []).sort(byName)
    }
    const group =
      row.state === 'synced'
        ? groups.synced
        : row.state === 'pending'
          ? groups.pending
          : groups.notSynced
    group.push(entry)
  }
  groups.synced = mergeTwins(groups.synced)
  groups.pending = mergeTwins(groups.pending)
  groups.notSynced = mergeTwins(groups.notSynced)
  // Ones a switch can turn back on come before skips nothing here can fix.
  groups.notSynced.sort(
    (a, b) =>
      Number(!cloudSkillsRowToggleable(a.row)) - Number(!cloudSkillsRowToggleable(b.row)) ||
      byName(a.row, b.row)
  )
  return groups
}

export function cloudSkillsRowStateLabel(
  row: AgentConfigSyncRow,
  included: boolean,
  t: Translate = translate
): string {
  if (row.state === 'synced') {
    return t('cloudSkillsSync.state.synced', 'Synced')
  }
  return row.state === 'pending' && included
    ? t('cloudSkillsSync.state.pending', 'Not synced yet')
    : t('cloudSkillsSync.state.skipped', 'Not synced')
}
