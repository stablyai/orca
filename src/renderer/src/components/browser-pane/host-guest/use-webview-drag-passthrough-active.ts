import { useSyncExternalStore } from 'react'
import {
  isWebviewDragPassthroughActive,
  registerWebviewDragPassthroughSurface
} from './webview-drag-passthrough'

function subscribe(onStoreChange: () => void): () => void {
  return registerWebviewDragPassthroughSurface(onStoreChange)
}

/** Guest focus blurs the embedder and aborts renderer drags; panes use this state to defer guest effects. */
export function useWebviewDragPassthroughActive(): boolean {
  return useSyncExternalStore(subscribe, isWebviewDragPassthroughActive, () => false)
}
