import type { BrowserClientRetainedRendererPage } from './browser-client-page-retained-state'

// Pages this window handed to Memory Saver; their guest loss is a free, not a failure.
const freedPageIds = new Set<string>()
// The server takes only metadata newer than it has seen, so a remade page continues the count.
const freedMetadataRevisions = new Map<string, number>()

export function markBrowserClientPageFreed(browserPageId: string): void {
  freedPageIds.add(browserPageId)
}

export function isBrowserClientPageFreed(browserPageId: string): boolean {
  return freedPageIds.has(browserPageId)
}

export function noteBrowserClientPageMounted(browserPageId: string): void {
  freedPageIds.delete(browserPageId)
}

export function keepFreedBrowserClientPageRevision(page: BrowserClientRetainedRendererPage): void {
  if (freedPageIds.has(page.identity.browserPageId)) {
    freedMetadataRevisions.set(page.key, page.metadataRevision)
  }
}

export function takeFreedBrowserClientPageRevision(key: string): number {
  const revision = freedMetadataRevisions.get(key) ?? 0
  freedMetadataRevisions.delete(key)
  return revision
}
