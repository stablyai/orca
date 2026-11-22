import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from '../browser-slice-contract'
import { omitRecordKeys } from '../../worktrees/teardown/record-key-omission'
import { setRemoteBrowserPageAudioMuted } from '../hosts/browser-remote-audio-mute'

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
      const setMuted = (next: boolean): void =>
        set((s) => {
          if (next === Boolean(s.browserAudioMutedTabIds[tabId])) {
            return s
          }
          return {
            browserAudioMutedTabIds: next
              ? { ...s.browserAudioMutedTabIds, [tabId]: true }
              : omitRecordKeys(s.browserAudioMutedTabIds, [tabId])
          }
        })
      setMuted(muted)
      const state = get()
      for (const page of state.browserPagesByWorkspace[tabId] ?? []) {
        const handle = state.remoteBrowserPageHandlesByPageId[page.id]
        if (handle && handle.placement?.kind !== 'client') {
          // The host's next row confirms the change; a refusal puts the icon back.
          void setRemoteBrowserPageAudioMuted(page.worktreeId, handle, muted)
            .then((applied) => {
              if (!applied) {
                setMuted(!muted)
              }
            })
            .catch(() => setMuted(!muted))
          continue
        }
        void window.api.browser.setPageAudioMuted({ browserPageId: page.id, muted })
      }
    }
  }
}
