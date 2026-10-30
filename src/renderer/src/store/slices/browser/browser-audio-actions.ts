import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'

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
        return {
          browserAudiblePageIds: audible
            ? { ...s.browserAudiblePageIds, [pageId]: true }
            : omitRecordKeys(s.browserAudiblePageIds, [pageId])
        }
      })
    },

    setBrowserTabAudioMuted: (tabId, muted) => {
      set((s) => {
        if (muted === Boolean(s.browserAudioMutedTabIds[tabId])) {
          return s
        }
        return {
          browserAudioMutedTabIds: muted
            ? { ...s.browserAudioMutedTabIds, [tabId]: true }
            : omitRecordKeys(s.browserAudioMutedTabIds, [tabId])
        }
      })
      for (const page of get().browserPagesByWorkspace[tabId] ?? []) {
        void window.api.browser.setPageAudioMuted({ browserPageId: page.id, muted })
      }
    }
  }
}
