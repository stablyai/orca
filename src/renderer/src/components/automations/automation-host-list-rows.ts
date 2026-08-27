/**
 * Turns cached per-host rows into the list the page renders.
 *
 * The rows keep their host of origin all the way through, because under All
 * hosts two authorities can hold records with the same name and only the
 * originating host explains which is which. `answered` is the honest gate: until
 * some host in view has actually committed a response, this projection has
 * nothing to say and the caller keeps whatever it already had.
 */

import type { Automation } from '../../../../shared/automations-types'
import type { AutomationHostCacheEntry } from './automation-host-cache-types'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'
import {
  captureAutomationOwners,
  type AutomationCapturedOwner,
  type AutomationCapturedRow
} from './automation-captured-owner'
import {
  automationAuthorityRecordKey,
  automationListRowKey,
  type AutomationListRow
} from './automation-list-row-identity'

export type AutomationHostGroupHost = {
  entry: AutomationHostCatalogEntry
  rows: readonly AutomationListRow[]
}

export type AutomationHostGroup = {
  authorityKey: string
  authorityLabel: string
  hosts: readonly AutomationHostGroupHost[]
}

export type AutomationHostListRows = {
  /**
   * Catalog-ordered, deduplicated per authority. Each row carries its own host
   * label and usage, because two authorities may hold the same automation ID and
   * a map keyed by that ID can only describe one of them.
   */
  rows: readonly AutomationListRow[]
  /** The same rows' records, for callers that only need the automations. */
  automations: readonly Automation[]
  /** Keyed by `AutomationListRow.key`; a bare ID cannot name one of two hosts' copies. */
  capturedOwners: ReadonlyMap<string, AutomationCapturedOwner>
  /** Populated only under All hosts; a single-host view needs no group headers. */
  groups: readonly AutomationHostGroup[]
  /** False until a host in view committed a response, cached or fresh. */
  answered: boolean
}

export type AutomationHostListRowsInput = {
  catalog: AutomationHostCatalog
  resolution: AutomationHostFilterResolution
  entry: (stableKey: string) => AutomationHostCacheEntry | null
}

const EMPTY_ROWS: AutomationHostListRows = {
  rows: [],
  automations: [],
  capturedOwners: new Map(),
  groups: [],
  answered: false
}

export type AutomationHostGroupVisibleHost = AutomationHostGroupHost & {
  /** Rows the host had before the query, so an emptied group can name the query as the cause. */
  hostRowCount: number
}

export type AutomationHostVisibleGroup = Omit<AutomationHostGroup, 'hosts'> & {
  hosts: readonly AutomationHostGroupVisibleHost[]
}

/**
 * Applies the list search to the grouped view. Empty groups are kept: a host
 * whose rows the query hid still owes the user its status row, and dropping it
 * would make a search look like a host disappearing.
 */
export function filterAutomationHostGroups(
  groups: readonly AutomationHostGroup[],
  visibleRowKeys: ReadonlySet<string>
): readonly AutomationHostVisibleGroup[] {
  return groups.map((group) => ({
    ...group,
    hosts: group.hosts.map((host) => ({
      ...host,
      hostRowCount: host.rows.length,
      rows: host.rows.filter((row) => visibleRowKeys.has(row.key))
    }))
  }))
}

/** Which hosts the current filter puts on screen, in catalog order. */
export function automationHostEntriesInView(
  input: Pick<AutomationHostListRowsInput, 'catalog' | 'resolution'>
): readonly AutomationHostCatalogEntry[] {
  if (input.resolution.effective.kind === 'all') {
    return input.catalog.entries
  }
  return input.resolution.entry ? [input.resolution.entry] : []
}

export function resolveAutomationHostListRows(
  input: AutomationHostListRowsInput
): AutomationHostListRows {
  const entries = automationHostEntriesInView(input)
  if (entries.length === 0) {
    return EMPTY_ROWS
  }
  const rows: AutomationListRow[] = []
  const seen = new Set<string>()
  const groups: AutomationHostGroup[] = []
  const groupByKey = new Map<string, AutomationHostGroup & { hosts: AutomationHostGroupHost[] }>()
  const capturedRows: AutomationCapturedRow[] = []
  let answered = false

  for (const entry of entries) {
    const cached = input.entry(entry.stableKey)
    if (cached && cached.fetchedAt !== null) {
      answered = true
    }
    const authorityKey = automationAuthorityCatalogKey(entry.stableRef.authority)
    const hostRows: AutomationListRow[] = []
    for (const row of cached?.data ?? []) {
      // Scoped to the authority: another authority's identically named record is
      // a different record, and dropping it would hide a row the user stored.
      const recordKey = automationAuthorityRecordKey(authorityKey, row.automation.id)
      if (seen.has(recordKey)) {
        continue
      }
      seen.add(recordKey)
      const listRow: AutomationListRow = {
        key: automationListRowKey(entry.stableKey, row.automation.id),
        automation: row.automation,
        catalogRef: entry.stableRef,
        hostLabel: entry.label,
        usageSummary: row.usageSummary ?? null
      }
      capturedRows.push({ rowKey: listRow.key, row })
      rows.push(listRow)
      hostRows.push(listRow)
    }
    let group = groupByKey.get(authorityKey)
    if (!group) {
      group = { authorityKey, authorityLabel: entry.authorityLabel, hosts: [] }
      groupByKey.set(authorityKey, group)
      groups.push(group)
    }
    group.hosts.push({ entry, rows: hostRows })
  }

  return {
    rows,
    automations: rows.map((row) => row.automation),
    // Catalog order decides duplicates, and it places an authority's Self and
    // SSH hosts before its orphan bucket — so a record keeps its owner rather
    // than the ownerless copy the orphan scope also returns.
    capturedOwners: captureAutomationOwners(capturedRows),
    groups: input.resolution.effective.kind === 'all' ? groups : [],
    answered
  }
}
