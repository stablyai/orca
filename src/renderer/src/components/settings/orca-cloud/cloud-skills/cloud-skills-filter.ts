import {
  AGENT_CONFIG_OPT_IN_KINDS,
  type AgentConfigSyncRow
} from '../../../../../../shared/agent-config-sync/agent-config-sync-contract'
import {
  cloudSkillsEntryCount,
  cloudSkillsEntryKeys,
  cloudSkillsRowToggleable,
  type CloudSkillsEntry,
  type CloudSkillsGroups
} from './cloud-skills-sync-copy'

export type CloudSkillsFilter = 'all' | 'enabled' | 'disabled'

/** Enabled: the switch is on. Disabled: the user switched it off. Rows with no switch (looks like a
 * key, in the repo, too large…) are neither: they show under All only. */
export function cloudSkillsEntryFilter(
  entry: CloudSkillsEntry,
  excluded: ReadonlySet<string>
): Exclude<CloudSkillsFilter, 'all'> | null {
  if (!cloudSkillsRowToggleable(entry.row)) {
    return null
  }
  return cloudSkillsEntryKeys(entry).some((key) => excluded.has(key)) ? 'disabled' : 'enabled'
}

const allEntries = (groups: CloudSkillsGroups): CloudSkillsEntry[] => [
  ...groups.synced,
  ...groups.pending,
  ...groups.notSynced
]

/** Item counts (twins and copies count), so "Enabled 9" matches what was copied. */
export function cloudSkillsFilterCounts(
  groups: CloudSkillsGroups,
  excluded: ReadonlySet<string>
): Record<CloudSkillsFilter, number> {
  const entries = allEntries(groups)
  const count = (filter: Exclude<CloudSkillsFilter, 'all'>): number =>
    cloudSkillsEntryCount(entries.filter((e) => cloudSkillsEntryFilter(e, excluded) === filter))
  return {
    all: cloudSkillsEntryCount(entries),
    enabled: count('enabled'),
    disabled: count('disabled')
  }
}

/** The groups a filter shows. `pinned` rows were toggled under this filter: they stay until the
 * filter changes, so a row never vanishes from under the pointer. */
export function cloudSkillsFilterGroups(
  groups: CloudSkillsGroups,
  filter: CloudSkillsFilter,
  excluded: ReadonlySet<string>,
  pinned: ReadonlySet<string>
): CloudSkillsGroups {
  if (filter === 'all') {
    return groups
  }
  const keep = (entry: CloudSkillsEntry): boolean =>
    pinned.has(entry.row.key) || cloudSkillsEntryFilter(entry, excluded) === filter
  return {
    synced: groups.synced.filter(keep),
    pending: groups.pending.filter(keep),
    notSynced: groups.notSynced.filter(keep)
  }
}

export function cloudSkillsFilterIsEmpty(groups: CloudSkillsGroups): boolean {
  return allEntries(groups).length === 0
}

/** The switch state for every row: an opt-in item (memory) is off until the user turned it on. */
export function cloudSkillsEffectiveExcluded(
  rows: readonly AgentConfigSyncRow[],
  excluded: readonly string[],
  optedIn: readonly string[]
): ReadonlySet<string> {
  const on = new Set(optedIn)
  const off = new Set(excluded)
  for (const row of rows) {
    if (AGENT_CONFIG_OPT_IN_KINDS.has(row.kind) && !on.has(row.key)) {
      off.add(row.key)
    }
  }
  return off
}
