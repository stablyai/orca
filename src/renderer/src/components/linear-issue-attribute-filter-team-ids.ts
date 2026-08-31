import type { LinearTeam } from '../../../shared/linear/workspace-types'

/**
 * Resolve which Linear team ids should feed attribute-filter metadata.
 * Empty selection falls back to the same primary-team default as before;
 * non-empty selection returns every selected team (sorted for stable loads).
 */
export function resolveLinearIssueAttributeFilterTeamIds(options: {
  selectedTeamIds: readonly string[]
  availableTeams: readonly LinearTeam[]
  primaryTeamId: string | null
}): string[] {
  const { selectedTeamIds, availableTeams, primaryTeamId } = options
  const availableIds = new Set(availableTeams.map((team) => team.id))
  const selected = selectedTeamIds.filter((id) => availableIds.has(id))
  if (selected.length > 0) {
    // Stable order: name/id of available teams, not click order — matches primary-team sort.
    const byId = new Map(availableTeams.map((team) => [team.id, team] as const))
    return [...selected].sort((a, b) => {
      const teamA = byId.get(a)
      const teamB = byId.get(b)
      const nameCmp = (teamA?.name ?? a).localeCompare(teamB?.name ?? b)
      if (nameCmp !== 0) {
        return nameCmp
      }
      return a.localeCompare(b)
    })
  }
  if (primaryTeamId && availableIds.has(primaryTeamId)) {
    return [primaryTeamId]
  }
  return []
}

/** Deduplicate metadata rows by id, preserving first-seen order. */
export function unionLinearMetadataById<T extends { id: string }>(groups: readonly T[][]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.id)) {
        continue
      }
      seen.add(item.id)
      out.push(item)
    }
  }
  return out
}

/** One picker row standing for every id that shares a display name. */
export type LinearMetadataNameGroup = { key: string; name: string; ids: string[] }

/**
 * Collapse metadata rows that share a display name. Linear workflow states (and team
 * labels) are per team, so every selected team contributes its own "Todo" id — the app
 * already treats status identity as the name, so the picker must too (#16785).
 */
export function groupLinearMetadataByName<T extends { id: string; name: string }>(
  rows: readonly T[]
): LinearMetadataNameGroup[] {
  const byName = new Map<string, LinearMetadataNameGroup>()
  for (const row of rows) {
    const group = byName.get(row.name)
    if (group) {
      group.ids.push(row.id)
      continue
    }
    // First id doubles as the row key: unique, and stable while metadata is unchanged.
    byName.set(row.name, { key: row.id, name: row.name, ids: [row.id] })
  }
  return [...byName.values()]
}

/**
 * Group keys for the selected ids. An id no loaded group covers — a facet from a team
 * whose metadata is not in yet — passes through as its own key so toggling another row
 * never drops it (R12).
 */
export function selectedLinearMetadataGroupKeys(
  groups: readonly { key: string; ids: readonly string[] }[],
  selectedIds: readonly string[]
): string[] {
  const keyById = linearMetadataKeyById(groups)
  return [...new Set(selectedIds.map((id) => keyById.get(id) ?? id))]
}

function linearMetadataKeyById(
  groups: readonly { key: string; ids: readonly string[] }[]
): Map<string, string> {
  const keyById = new Map<string, string>()
  for (const group of groups) {
    for (const id of group.ids) {
      keyById.set(id, group.key)
    }
  }
  return keyById
}

/** Ids the picked rows stand for, against the ids the transport cap actually kept (#16879). */
export function linearMetadataGroupCoverage(
  groups: readonly { key: string; ids: readonly string[] }[],
  selectedIds: readonly string[]
): { applied: number; intended: number } {
  const keys = selectedLinearMetadataGroupKeys(groups, selectedIds)
  return {
    applied: selectedIds.length,
    intended: expandLinearMetadataGroupKeys(groups, keys).length
  }
}

/**
 * The ids a cap is known to have trimmed, kept as the ids that survived it. A row the cap
 * could not fit leaves no trace in those ids, so truncation is recorded where it happens
 * rather than inferred from the bounded filter — a complete selection landing exactly on the
 * cap is indistinguishable from a trimmed one and used to warn anyway (STA-5996).
 */
export type LinearMetadataTruncationRecord = readonly string[] | null

export function recordLinearMetadataTruncation(
  requestedIds: readonly string[],
  appliedIds: readonly string[]
): LinearMetadataTruncationRecord {
  return new Set(requestedIds).size > new Set(appliedIds).size ? [...appliedIds] : null
}

/** A record describes the facet only while it still carries exactly the ids that survived. */
export function isLinearMetadataTruncated(
  record: LinearMetadataTruncationRecord,
  appliedIds: readonly string[]
): boolean {
  // Why: an empty record matches an empty facet vacuously, and a facet filtering nothing
  // cannot be under-covering — so no empty record ever reports truncation.
  if (record === null || record.length === 0) {
    return false
  }
  const applied = new Set(appliedIds)
  const recorded = new Set(record)
  return recorded.size === applied.size && record.every((id) => applied.has(id))
}

/** True when the filter cannot be shown to cover every team id the picked rows stand for. */
export function isLinearMetadataGroupSelectionPartial(
  groups: readonly { key: string; ids: readonly string[] }[],
  selectedIds: readonly string[],
  truncated: boolean
): boolean {
  const { applied, intended } = linearMetadataGroupCoverage(groups, selectedIds)
  // Why: the value-derived shortfall stays as a fallback — a restored filter carries no record.
  return truncated || intended > applied
}

/**
 * Trim an expanded selection to `max` ids by taking turns across the picked groups.
 * A plain slice of the canonical (sorted) id list can drop every id of one picked row,
 * which then renders unchecked with no explanation and vanishes from the coverage count.
 * More picked rows than `max` cannot all be represented; the caller records that shortfall
 * with `recordLinearMetadataTruncation` so the starved row is never passed off as coverage.
 */
export function capLinearMetadataIdsAcrossGroups(
  groups: readonly { key: string; ids: readonly string[] }[],
  ids: readonly string[],
  max: number
): string[] {
  if (ids.length <= max) {
    return [...ids]
  }
  const selected = new Set(ids)
  // Why: the picker hands us click order, so bucket by metadata order instead — the same
  // visible selection must always cap to the same ids (#17342).
  const lists = groups
    .map((group) => group.ids.filter((id) => selected.has(id)))
    .filter((list) => list.length > 0)
  const grouped = new Set(lists.flat())
  // An id no loaded group covers is its own row; sorted so its slot is stable too (R12).
  lists.push(
    ...[...new Set(ids)]
      .filter((id) => !grouped.has(id))
      .sort()
      .map((id) => [id])
  )
  const capped: string[] = []
  // Round 0 gives every row one id before any row gets a second.
  for (let round = 0; capped.length < max; round += 1) {
    let advanced = false
    for (const list of lists) {
      const id = list[round]
      if (id === undefined) {
        continue
      }
      advanced = true
      capped.push(id)
      if (capped.length >= max) {
        break
      }
    }
    if (!advanced) {
      break
    }
  }
  return capped
}

/** Every id behind the picked group keys; an unknown key is itself an id. */
export function expandLinearMetadataGroupKeys(
  groups: readonly { key: string; ids: readonly string[] }[],
  keys: readonly string[]
): string[] {
  const idsByKey = new Map(groups.map((group) => [group.key, group.ids] as const))
  return keys.flatMap((key) => [...(idsByKey.get(key) ?? [key])])
}
