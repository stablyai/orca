/** Keep host origin on every visible row. Until a host in view commits an answer, preserve the caller’s prior rows instead of claiming an empty result. */

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
  /** Catalog-ordered rows deduplicated per authority, with their own host/usage; bare IDs collide across authorities. */
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

/** Keep host status groups even when search hides every row; filtering must not look like host removal. */
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
      // Deduplicate within the authority; matching IDs on another host name different stored records.
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
    // Catalog order places owned Self/SSH copies before ownerless orphan copies, preserving captured ownership.
    capturedOwners: captureAutomationOwners(capturedRows),
    groups: input.resolution.effective.kind === 'all' ? groups : [],
    answered
  }
}
