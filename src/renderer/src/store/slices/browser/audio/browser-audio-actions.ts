import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from '../browser-slice-contract'
import { omitRecordKeys } from '../../worktrees/teardown/record-key-omission'
import { setRemoteBrowserPageAudioMuted } from '../hosts/browser-remote-audio-mute'

const remoteMuteGenerationByTabId = new Map<string, number>()

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
      const generation = (remoteMuteGenerationByTabId.get(tabId) ?? 0) + 1
      remoteMuteGenerationByTabId.set(tabId, generation)
      // A refusal puts the icon back, unless a newer toggle already superseded this one.
      const isCurrent = (): boolean => remoteMuteGenerationByTabId.get(tabId) === generation
      const rollBack = (): void => {
        if (isCurrent()) {
          setMuted(!muted)
        }
      }
      for (const page of state.browserPagesByWorkspace[tabId] ?? []) {
        const handle = state.remoteBrowserPageHandlesByPageId[page.id]
        if (handle && handle.placement?.kind !== 'client') {
          // The host's next row confirms the change.
          void setRemoteBrowserPageAudioMuted(page.worktreeId, handle, muted, isCurrent)
            .then((applied) => {
              if (!applied) {
                rollBack()
              }
            })
            .catch(rollBack)
          continue
        }
        void window.api.browser.setPageAudioMuted({ browserPageId: page.id, muted })
      }
    }
  }
}
