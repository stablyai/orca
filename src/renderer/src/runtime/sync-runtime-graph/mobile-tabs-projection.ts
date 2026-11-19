import type { AppState } from '@/store/types'
import { readRecordChanges } from '@/store/record-transitions/keyed-record-change-reads'
import { isIndexKey } from '@/store/record-transitions/keyed-record-index-keys'
import { graphState } from './graph-state'
import type { TabsProjectionCacheEntry } from './types'

function tabsProjectionEntry(
  worktreeId: string,
  tabs: NonNullable<AppState['tabsByWorktree'][string]>,
  previous: TabsProjectionCacheEntry | undefined
): TabsProjectionCacheEntry {
  if (previous?.tabs === tabs) {
    return previous
  }
  const projection = JSON.stringify(
    tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      quickCommandLabel: tab.quickCommandLabel,
      aiVaultTitle: tab.aiVaultTitle,
      generatedTitle: tab.generatedTitle,
      customTitle: tab.customTitle,
      launchAgent: tab.launchAgent
    }))
  )
  return { worktreeId, tabs, projection }
}

/** A revision that moves only when a mobile-visible tab field, or the workspace set or order, changed. */
export function buildRuntimeMobileTabsProjection(
  tabsByWorktree: AppState['tabsByWorktree']
): number {
  const cached = graphState.cachedTabsProjection
  if (cached?.source === tabsByWorktree) {
    return cached.revision
  }
  const changes = cached ? readRecordChanges(tabsByWorktree, cached.source) : null
  // Records list integer-like keys first, which an appended Map entry can't mirror; rebuild then.
  if (cached && changes?.kind === 'addressed' && !changes.added.some(isIndexKey)) {
    // Annotated writes name the buckets they replaced; reproject only those.
    let changed = changes.added.length > 0 || changes.deleted.size > 0
    // Surviving keys stay in place; added ones follow in source order, as the record holds them.
    const added = new Set(changes.added)
    const replaced = [...changes.keys].filter((key) => !added.has(key))
    for (const worktreeId of [...replaced, ...changes.added]) {
      const previous = cached.entries.get(worktreeId)
      const tabs = Object.hasOwn(tabsByWorktree, worktreeId)
        ? tabsByWorktree[worktreeId]
        : undefined
      if (!tabs) {
        cached.entries.delete(worktreeId)
        continue
      }
      const entry = tabsProjectionEntry(worktreeId, tabs, previous)
      changed ||= entry.projection !== previous?.projection
      cached.entries.set(worktreeId, entry)
    }
    cached.source = tabsByWorktree
    cached.revision += changed ? 1 : 0
    return cached.revision
  }
  const entries = new Map<string, TabsProjectionCacheEntry>()
  const previousOrder = cached ? [...cached.entries.values()] : []
  let changed = !cached
  let index = 0
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const prior = previousOrder[index++]
    const entry = tabsProjectionEntry(worktreeId, tabs, cached?.entries.get(worktreeId))
    changed ||= prior?.worktreeId !== worktreeId || prior.projection !== entry.projection
    entries.set(worktreeId, entry)
  }
  changed ||= index !== previousOrder.length
  const revision = (cached?.revision ?? 0) + (changed ? 1 : 0)
  graphState.cachedTabsProjection = { source: tabsByWorktree, entries, revision }
  return revision
}
