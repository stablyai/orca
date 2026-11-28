import type { ArtifactListItem } from '../../../../shared/artifacts/artifacts'
import type { RailPageSort } from '@/components/rail-page/RailPageSortHeader'
import type { Translate } from '@/i18n/use-translate'
import { artifactName, artifactTypeLabel } from './artifact-display-labels'

export type ArtifactListUpdatedFilter = 'any' | 'today' | 'week' | 'month'
export type ArtifactListExpiresFilter = 'any' | 'week' | 'expired'

export type ArtifactListFilter = {
  /** Source content types; empty means every type. */
  types: readonly string[]
  updated: ArtifactListUpdatedFilter
  expires: ArtifactListExpiresFilter
}

export const EMPTY_ARTIFACT_LIST_FILTER: ArtifactListFilter = {
  types: [],
  updated: 'any',
  expires: 'any'
}

export type ArtifactListSortField = 'name' | 'type' | 'size' | 'updated' | 'expires'
export type ArtifactListSort = RailPageSort<ArtifactListSortField>

export const DEFAULT_ARTIFACT_LIST_SORT: ArtifactListSort = { field: 'updated', direction: 'desc' }

const DAY_MS = 24 * 60 * 60 * 1000

export function countArtifactListFilters(filter: ArtifactListFilter): number {
  return (
    Number(filter.types.length > 0) +
    Number(filter.updated !== 'any') +
    Number(filter.expires !== 'any')
  )
}

/** asc → desc → off, where off is the default order (Updated, newest first). On the Updated column
 * itself off would change nothing, so it flips between desc and asc instead. */
export function nextArtifactListSort(
  current: ArtifactListSort,
  field: ArtifactListSortField
): ArtifactListSort {
  if (current.field !== field) {
    return { field, direction: 'asc' }
  }
  if (current.direction === 'asc') {
    return { field, direction: 'desc' }
  }
  return field === DEFAULT_ARTIFACT_LIST_SORT.field
    ? { field, direction: 'asc' }
    : DEFAULT_ARTIFACT_LIST_SORT
}

export type ArtifactTypeOption = { type: string; label: string; count: number }

/** Types present in the loaded list, in first-seen order, so the menu never offers an empty type. */
export function artifactTypeOptions(
  artifacts: readonly ArtifactListItem[],
  t?: Translate
): ArtifactTypeOption[] {
  const options = new Map<string, ArtifactTypeOption>()
  for (const item of artifacts) {
    const type = item.artifact.sourceContentType
    const existing = options.get(type)
    if (existing) {
      existing.count += 1
    } else {
      options.set(type, { type, label: artifactTypeLabel(item, t), count: 1 })
    }
  }
  return Array.from(options.values())
}

function startOfLocalDayMs(nowMs: number): number {
  const day = new Date(nowMs)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

function updatedSinceMs(filter: ArtifactListUpdatedFilter, nowMs: number): number | null {
  switch (filter) {
    case 'today':
      return startOfLocalDayMs(nowMs)
    case 'week':
      return nowMs - 7 * DAY_MS
    case 'month':
      return nowMs - 30 * DAY_MS
    case 'any':
      return null
  }
}

function matchesExpires(expiresAtMs: number, filter: ArtifactListExpiresFilter, nowMs: number) {
  if (filter === 'any') {
    return true
  }
  if (Number.isNaN(expiresAtMs)) {
    return false
  }
  return filter === 'expired'
    ? expiresAtMs <= nowMs
    : expiresAtMs > nowMs && expiresAtMs <= nowMs + 7 * DAY_MS
}

export function filterArtifactList(
  artifacts: readonly ArtifactListItem[],
  filter: ArtifactListFilter,
  nowMs: number
): readonly ArtifactListItem[] {
  if (countArtifactListFilters(filter) === 0) {
    return artifacts
  }
  const types = filter.types.length > 0 ? new Set(filter.types) : null
  const updatedSince = updatedSinceMs(filter.updated, nowMs)
  return artifacts.filter(({ artifact }) => {
    if (types && !types.has(artifact.sourceContentType)) {
      return false
    }
    // Invalid timestamps parse to NaN, which fails the comparison and drops the row.
    if (updatedSince !== null && !(Date.parse(artifact.updatedAt) >= updatedSince)) {
      return false
    }
    return matchesExpires(Date.parse(artifact.expiresAt), filter.expires, nowMs)
  })
}

function sortKey(
  item: ArtifactListItem,
  field: ArtifactListSortField,
  t: Translate | undefined
): string | number {
  switch (field) {
    case 'name':
      return artifactName(item)
    case 'type':
      return artifactTypeLabel(item, t)
    case 'size':
      return item.artifact.byteSize
    case 'updated':
      return Date.parse(item.artifact.updatedAt)
    case 'expires':
      return Date.parse(item.artifact.expiresAt)
  }
}

/** Decorate once so each comparison reads a precomputed key instead of re-parsing dates or labels. */
export function sortArtifactList(
  artifacts: readonly ArtifactListItem[],
  sort: ArtifactListSort | null,
  locale: string | undefined,
  t?: Translate
): readonly ArtifactListItem[] {
  if (!sort || artifacts.length < 2) {
    return artifacts
  }
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true })
  const sign = sort.direction === 'asc' ? 1 : -1
  const decorated = artifacts.map((item, index) => ({
    item,
    index,
    key: sortKey(item, sort.field, t)
  }))
  decorated.sort((left, right) => {
    const a = left.key
    const b = right.key
    if (typeof a === 'number' && typeof b === 'number') {
      // Unparseable timestamps sort last in either direction.
      const aMissing = Number.isNaN(a)
      const bMissing = Number.isNaN(b)
      if (aMissing || bMissing) {
        return aMissing === bMissing ? left.index - right.index : aMissing ? 1 : -1
      }
      return (a - b) * sign || left.index - right.index
    }
    return collator.compare(String(a), String(b)) * sign || left.index - right.index
  })
  return decorated.map(({ item }) => item)
}
