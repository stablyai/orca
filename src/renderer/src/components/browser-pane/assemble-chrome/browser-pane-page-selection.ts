import type { BrowserPage } from '../../../../../shared/browser-workspace-types'

const EMPTY_BROWSER_PAGES: BrowserPage[] = []

export function getBrowserPagesForWorkspace(
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  workspaceId: string
): BrowserPage[] {
  return browserPagesByWorkspace[workspaceId] ?? EMPTY_BROWSER_PAGES
}
