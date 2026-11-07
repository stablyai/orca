import type { BrowserTab } from '../../../../../shared/browser-workspace-types'

export function makeBrowserTab(
  overrides: Partial<BrowserTab> & { id: string; worktreeId: string; url: string }
): BrowserTab {
  return {
    title: overrides.url,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: Date.now(),
    ...overrides
  }
}
