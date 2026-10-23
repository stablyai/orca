import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import { findPage } from '../browser-page-records'

export function createBrowserAudioActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'setBrowserPageAudible' | 'setBrowserTabAudioMuted'> {
  return {
    setBrowserPageAudible: (pageId, audible) => {
      set((s) => {
        if (audible === Boolean(s.browserAudiblePageIds[pageId])) {
          return s
        }
        if (!audible) {
          const next = { ...s.browserAudiblePageIds }
          delete next[pageId]
          return { browserAudiblePageIds: next }
        }
        if (!findPage(s.browserPagesByWorkspace, pageId)) {
          return s
        }
        return { browserAudiblePageIds: { ...s.browserAudiblePageIds, [pageId]: true } }
      })
    },

    setBrowserTabAudioMuted: (tabId, muted) => {
      set((s) => {
        if (muted === Boolean(s.browserAudioMutedTabIds[tabId])) {
          return s
        }
        const next = { ...s.browserAudioMutedTabIds }
        if (muted) {
          next[tabId] = true
        } else {
          delete next[tabId]
        }
        return { browserAudioMutedTabIds: next }
      })
      for (const page of get().browserPagesByWorkspace[tabId] ?? []) {
        void window.api.browser.setPageAudioMuted({ browserPageId: page.id, muted })
      }
    }
  }
}
