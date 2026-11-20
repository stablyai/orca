import { copyBrowserPageHandles } from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
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
        remoteBrowserPageHandlesByPageId: Object.assign(
          copyBrowserPageHandles(s.remoteBrowserPageHandlesByPageId, [pageId]),
          { [pageId]: handle }
        )
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
        const nextRemoteBrowserPageHandlesByPageId = copyBrowserPageHandles(
          s.remoteBrowserPageHandlesByPageId,
          [pageId]
        )
        delete nextRemoteBrowserPageHandlesByPageId[pageId]
        return { remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId }
      })
      return removedHandle
    }
  }
}
