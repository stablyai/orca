import { useSyncExternalStore } from 'react'
import {
  isWebviewDragPassthroughActive,
  registerWebviewDragPassthroughSurface
} from './webview-drag-passthrough'

function subscribe(onStoreChange: () => void): () => void {
  return registerWebviewDragPassthroughSurface(onStoreChange)
}

/** Whether a renderer-owned drag currently holds guests click-through. Panes read it to keep
 *  their own effects off the guest mid-drag: focusing a guest hands focus to another WebContents,
 *  and the embedder blur that follows is what the drag's missed-end fallback treats as an abort. */
export function useWebviewDragPassthroughActive(): boolean {
  return useSyncExternalStore(subscribe, isWebviewDragPassthroughActive, () => false)
}
