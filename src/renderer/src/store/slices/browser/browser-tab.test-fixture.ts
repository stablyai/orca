import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'

export function makeBrowserTab(
  overrides: Partial<BrowserWorkspace> & { id: string; worktreeId: string; url: string }
): BrowserWorkspace {
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
