/**
 * Turns an authority's answer into cache rows.
 *
 * Scoped rows keep the owner they were fetched under so every later action can
 * fence on it. Legacy rows keep no owner and no usage: the old response proves
 * neither, and the design forbids compensating with run-history downloads.
 */

import type { Automation } from '../../../../shared/automations-types'
import type { AutomationListItem } from '../../../../shared/automation-list-scope'
import {
  partitionLegacyAutomationList,
  type LegacyAutomationPartitionContext,
  type LegacyAutomationSelector
} from '../../../../shared/automation-legacy-list-partition'
import type {
  AutomationAuthorityRef,
  AutomationOwnerRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import type { ScopedAutomationList } from './automation-scoped-list-client'
import type { AutomationHostRow } from './automation-host-cache-types'

function ownerForItem(
  authority: AutomationAuthorityRef,
  item: AutomationListItem
): AutomationOwnerRef | null {
  if (item.selector.kind === 'orphan') {
    return null
  }
  return item.selector.kind === 'ssh'
    ? {
        authority,
        selector: {
          kind: 'ssh',
          targetId: item.selector.targetId,
          targetGeneration: item.selector.targetGeneration
        }
      }
    : { authority, selector: { kind: 'self' } }
}

export function toScopedAutomationHostRows(
  authority: AutomationAuthorityRef,
  result: ScopedAutomationList
): AutomationHostRow[] {
  const itemsById = new Map(result.items.map((item) => [item.automationId, item]))
  const rows: AutomationHostRow[] = []
  for (const automation of result.automations) {
    const item = itemsById.get(automation.id)
    if (!item) {
      continue
    }
    const usageSummary = item.usageSummary ?? null
    rows.push({
      automation,
      owner: ownerForItem(authority, item),
      selector: item.selector,
      usageSummary,
      // An absent or unreadable projection reads as unavailable rather than as zero usage.
      usageKnown: usageSummary !== null
    })
  }
  return rows
}

export type LegacyAutomationHostPartition = {
  rowsByStableKey: Map<string, AutomationHostRow[]>
  orphanCount: number
}

function legacySelectorMatches(
  selector: LegacyAutomationSelector,
  ref: StableAutomationCatalogRef
): boolean {
  if (selector.kind !== ref.selector.kind) {
    return false
  }
  return selector.kind === 'ssh' && ref.selector.kind === 'ssh'
    ? selector.targetId === ref.selector.targetId
    : true
}

/**
 * Fans one unscoped response out to every entry that asked for it, so an old
 * runtime is queried once per cycle rather than once per selector.
 */
export function partitionLegacyAutomationHostRows(
  automations: readonly Automation[],
  refs: readonly StableAutomationCatalogRef[],
  context: LegacyAutomationPartitionContext,
  keyOf: (ref: StableAutomationCatalogRef) => string
): LegacyAutomationHostPartition {
  const partition = partitionLegacyAutomationList(automations, context)
  const rowsByStableKey = new Map<string, AutomationHostRow[]>()
  for (const ref of refs) {
    rowsByStableKey.set(
      keyOf(ref),
      partition.rows
        .filter((row) => legacySelectorMatches(row.selector, ref))
        .map((row) => ({
          automation: row.automation,
          owner: null,
          selector: row.selector,
          usageSummary: null,
          usageKnown: false
        }))
    )
  }
  return { rowsByStableKey, orphanCount: partition.orphanCount }
}
