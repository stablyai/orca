import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'

/**
 * The one deterministic catalog order, shared by the picker and the All-hosts
 * grouped list so responses arriving out of order never reflow the page.
 *
 * Sort fields are precomputed once per rebuild and a single `Intl.Collator` is
 * constructed per call — never one per comparison.
 */

export type AutomationHostCatalogOrderOptions = {
  /** Injectable so tests can prove exactly one collator is built per rebuild. */
  createCollator?: () => Intl.Collator
}

type SortFields = {
  entry: AutomationHostCatalogEntry
  authorityRank: number
  authorityLabel: string
  authorityId: string
  kindRank: number
  label: string
  targetId: string
}

const KIND_RANK: Record<AutomationHostCatalogEntry['kind'], number> = {
  self: 0,
  ssh: 1,
  orphan: 2
}

function defaultCollator(): Intl.Collator {
  return new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
}

function toSortFields(entry: AutomationHostCatalogEntry): SortFields {
  const { authority, selector } = entry.stableRef
  return {
    entry,
    authorityRank: authority.kind === 'desktop' ? 0 : 1,
    authorityLabel: entry.authorityLabel,
    authorityId: authority.kind === 'desktop' ? '' : authority.environmentId,
    kindRank: KIND_RANK[entry.kind],
    label: entry.label,
    targetId: selector.kind === 'ssh' ? selector.targetId : ''
  }
}

// Why: ids are identifiers, not prose — compare them byte-wise so the tiebreak is locale-independent.
function compareIds(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}

export function orderAutomationHostCatalogEntries(
  entries: readonly AutomationHostCatalogEntry[],
  options?: AutomationHostCatalogOrderOptions
): AutomationHostCatalogEntry[] {
  const collator = (options?.createCollator ?? defaultCollator)()
  const decorated = entries.map(toSortFields)
  decorated.sort((a, b) => {
    if (a.authorityRank !== b.authorityRank) {
      return a.authorityRank - b.authorityRank
    }
    if (a.authorityId !== b.authorityId) {
      return (
        collator.compare(a.authorityLabel, b.authorityLabel) ||
        compareIds(a.authorityId, b.authorityId)
      )
    }
    if (a.kindRank !== b.kindRank) {
      return a.kindRank - b.kindRank
    }
    return collator.compare(a.label, b.label) || compareIds(a.targetId, b.targetId)
  })
  return decorated.map((fields) => fields.entry)
}
