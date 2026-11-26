import { useSyncExternalStore } from 'react'
import {
  isWebviewDragPassthroughActive,
  registerWebviewDragPassthroughSurface
} from './webview-drag-passthrough'

function subscribe(onStoreChange: () => void): () => void {
  return registerWebviewDragPassthroughSurface(onStoreChange)
}

/** Guest focus blurs the embedder and aborts renderer drags; panes use this state to defer guest effects. */
export function useWebviewDragPassthroughActive(enabled = true): boolean {
  // Inactive panes have nothing to defer, so they skip the per-drag re-render.
  return useSyncExternalStore(
    enabled ? subscribe : subscribeNever,
    enabled ? isWebviewDragPassthroughActive : readInactive,
    () => false
  )
}

const subscribeNever = (): (() => void) => () => {}
const readInactive = (): boolean => false
