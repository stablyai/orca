import type { BrowserSlice } from '../browser-slice-contract'

type RefreshState = Pick<BrowserSlice, 'changedFileRefreshByPageId'>
/** Only the refresh map is written, so any store holding it (the app store, a test store) can host these. */
type RefreshStateSet = (update: (state: RefreshState) => Partial<RefreshState>) => void

let nextRefreshSeq = 1

export function createChangedFilePageRefreshActions(
  set: RefreshStateSet
): Pick<
  BrowserSlice,
  | 'requestChangedFilePageRefresh'
  | 'setChangedFilePageRefreshBaseline'
  | 'settleChangedFilePageRefresh'
> {
  return {
    requestChangedFilePageRefresh: (pageId, resource) => {
      const intent = { seq: nextRefreshSeq++, requestedAt: performance.now(), resource }
      set((s) => ({
        changedFileRefreshByPageId: { ...s.changedFileRefreshByPageId, [pageId]: intent }
      }))
      return intent.seq
    },
    setChangedFilePageRefreshBaseline: (pageId, seq, baselineSeq) => {
      set((s) => {
        const intent = s.changedFileRefreshByPageId[pageId]
        if (intent?.seq !== seq || intent.baselineSeq !== undefined) {
          return {}
        }
        return {
          changedFileRefreshByPageId: {
            ...s.changedFileRefreshByPageId,
            [pageId]: { ...intent, baselineSeq }
          }
        }
      })
    },
    settleChangedFilePageRefresh: (pageId, seq) => {
      set((s) => {
        if (s.changedFileRefreshByPageId[pageId]?.seq !== seq) {
          return {}
        }
        const next = { ...s.changedFileRefreshByPageId }
        delete next[pageId]
        return { changedFileRefreshByPageId: next }
      })
    }
  }
}
