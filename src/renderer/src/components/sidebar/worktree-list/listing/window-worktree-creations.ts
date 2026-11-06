import type { SidebarFeedDomains } from '../../../../../../shared/sidebar-list/sidebar-feed-domains'

/** Combine main’s shared creations with window-only preflight/server work and exclude locally completed requests. */
export function withWindowCreations(
  domains: SidebarFeedDomains,
  pendingCreationKeys: readonly string[],
  endedCreationIds: ReadonlySet<string>,
  hiddenCreationKeys: readonly string[] = []
): SidebarFeedDomains {
  let creations: Map<string, { repoId: string }> | null = null
  for (const creationId of endedCreationIds) {
    if (domains.creations.has(creationId)) {
      creations ??= new Map(domains.creations)
      creations.delete(creationId)
    }
  }
  for (const key of hiddenCreationKeys) {
    const creationId = key.slice(0, key.indexOf(' '))
    if (domains.creations.has(creationId)) {
      creations ??= new Map(domains.creations)
      creations.delete(creationId)
    }
  }
  for (const key of pendingCreationKeys) {
    const separator = key.indexOf(' ')
    const creationId = key.slice(0, separator)
    if (!domains.creations.has(creationId)) {
      creations ??= new Map(domains.creations)
      creations.set(creationId, { repoId: key.slice(separator + 1) })
    }
  }
  return creations ? { ...domains, creations } : domains
}
