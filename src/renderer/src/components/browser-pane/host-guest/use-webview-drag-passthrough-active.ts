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
export function useWebviewDragPassthroughActive(enabled = true): boolean {
  // Why: an inactive pane has nothing to defer, so it stays off the per-drag re-render.
  return useSyncExternalStore(
    enabled ? subscribe : subscribeNever,
    enabled ? isWebviewDragPassthroughActive : readInactive,
    () => false
  )
}

const subscribeNever = (): (() => void) => () => {}
const readInactive = (): boolean => false
