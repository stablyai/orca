import type { BrowserSlice, BrowserSliceSet } from '../browser-slice-contract'
import { findPage, findWorkspace } from './browser-page-records'
import { preserveBrowserPageLoadingOwner } from '@/lib/browser/browser-page-loading-ownership'

export function createBrowserPageViewportActions(
  set: BrowserSliceSet
): Pick<BrowserSlice, 'setBrowserPageViewportPreset'> {
  return {
    setBrowserPageViewportPreset: (pageId, viewportPresetId) =>
      set((s) => {
        const page = findPage(s.browserPagesByWorkspace, pageId)
        if (!page) {
          return s
        }
        const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
        if (!workspace) {
          return s
        }
        const nextPages = (s.browserPagesByWorkspace[workspace.id] ?? []).map((entry) => {
          if (entry.id !== pageId) {
            return entry
          }
          const nextPage = { ...entry, viewportPresetId }
          preserveBrowserPageLoadingOwner(entry, nextPage)
          return nextPage
        })
        return {
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [workspace.id]: nextPages
          }
        }
      })
  }
}
