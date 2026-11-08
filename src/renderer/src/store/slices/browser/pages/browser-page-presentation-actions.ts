import type { BrowserSlice, BrowserSliceSet } from '../browser-slice-contract'
import { findPage, findWorkspace } from './browser-page-records'

export function createBrowserPagePresentationActions(
  set: BrowserSliceSet
): Pick<BrowserSlice, 'setBrowserPageViewportPreset' | 'setBrowserPageChromeless'> {
  return {
    setBrowserPageChromeless: (pageId, chromeless) =>
      set((s) => {
        const page = findPage(s.browserPagesByWorkspace, pageId)
        if (!page || page.chromeless === chromeless) {
          return s
        }
        return {
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [page.workspaceId]: s.browserPagesByWorkspace[page.workspaceId].map((entry) =>
              entry.id === pageId ? { ...entry, chromeless } : entry
            )
          }
        }
      }),
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
        const nextPages = (s.browserPagesByWorkspace[workspace.id] ?? []).map((entry) =>
          entry.id === pageId ? { ...entry, viewportPresetId } : entry
        )
        return {
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [workspace.id]: nextPages
          }
        }
      })
  }
}
