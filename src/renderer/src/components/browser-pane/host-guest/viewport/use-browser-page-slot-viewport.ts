import { useCallback, useSyncExternalStore } from 'react'
import {
  getBrowserOverlaySlotViewport,
  subscribeBrowserOverlaySlotViewport
} from './browser-page-viewport'

export function useBrowserPageSlotViewport(workspaceId: string): HTMLDivElement | null {
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      subscribeBrowserOverlaySlotViewport(workspaceId, listener),
    [workspaceId]
  )
  const getSnapshot = useCallback(() => getBrowserOverlaySlotViewport(workspaceId), [workspaceId])
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}
