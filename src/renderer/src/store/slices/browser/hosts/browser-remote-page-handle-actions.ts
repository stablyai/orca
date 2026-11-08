import type {
  BrowserSlice,
  BrowserSliceSet,
  RemoteBrowserPageHandle
} from '../browser-slice-contract'

export function createBrowserRemotePageHandleActions(
  set: BrowserSliceSet
): Pick<BrowserSlice, 'setRemoteBrowserPageHandle' | 'removeRemoteBrowserPageHandle'> {
  return {
    setRemoteBrowserPageHandle: (pageId, handle) => {
      set((s) => ({
        remoteBrowserPageHandlesByPageId: {
          ...s.remoteBrowserPageHandlesByPageId,
          [pageId]: handle
        }
      }))
    },
    removeRemoteBrowserPageHandle: (pageId, remotePageId) => {
      let removedHandle: RemoteBrowserPageHandle | null = null
      set((s) => {
        const current = s.remoteBrowserPageHandlesByPageId[pageId]
        if (!current || (remotePageId && current.remotePageId !== remotePageId)) {
          return s
        }
        removedHandle = current
        const nextRemoteBrowserPageHandlesByPageId = {
          ...s.remoteBrowserPageHandlesByPageId
        }
        delete nextRemoteBrowserPageHandlesByPageId[pageId]
        return { remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId }
      })
      return removedHandle
    }
  }
}
