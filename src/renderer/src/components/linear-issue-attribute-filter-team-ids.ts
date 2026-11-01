import type { LinearTeam } from '../../../shared/linear/workspace-types'

/** Use every selected team in stable order, falling back to the primary team only when selection is empty. */
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

export type LinearMetadataNameGroup = { key: string; name: string; ids: string[] }

/** Collapse same-named per-team states/labels into one picker row that selects all their ids. */
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
    byName.set(row.name, { key: row.id, name: row.name, ids: [row.id] })
  }
  return [...byName.values()]
}

/** Pass unknown ids through as group keys so incomplete metadata cannot lose selections when another row toggles. */
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

/** Record truncation where it occurs, storing surviving ids; a result exactly at the cap cannot reveal lost rows. */
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
  // Empty records match vacuously but empty filters cannot have incomplete coverage.
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

/** Distribute cap slots across rows; callers record truncation because excess rows may leave no surviving id or coverage trace. */
export function capLinearMetadataIdsAcrossGroups(
  groups: readonly { key: string; ids: readonly string[] }[],
  ids: readonly string[],
  max: number
): string[] {
  if (ids.length <= max) {
    return [...ids]
  }
  const selected = new Set(ids)
  // Use metadata order so equivalent selections cap identically regardless of click order.
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
