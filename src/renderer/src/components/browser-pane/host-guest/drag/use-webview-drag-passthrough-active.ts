import { useSyncExternalStore } from 'react'
import {
  isWebviewDragPassthroughActive,
  isWebviewPointerDragPassthroughActive,
  registerWebviewDragPassthroughSurface
} from './webview-drag-passthrough'

function subscribe(onStoreChange: () => void): () => void {
  return registerWebviewDragPassthroughSurface(onStoreChange)
}

/**
 * Guest focus blurs the embedder and aborts renderer drags; panes use this state to defer guest effects.
 * `ignoreNativeDrags` skips native HTML5 drags so guests that accept file drops still get them.
 */
export function useWebviewDragPassthroughActive(
  enabled = true,
  { ignoreNativeDrags = false } = {}
): boolean {
  const readActive = ignoreNativeDrags
    ? isWebviewPointerDragPassthroughActive
    : isWebviewDragPassthroughActive
  // Inactive panes have nothing to defer, so they skip the per-drag re-render.
  return useSyncExternalStore(
    enabled ? subscribe : subscribeNever,
    enabled ? readActive : readInactive,
    () => false
  )
}

const subscribeNever = (): (() => void) => () => {}
const readInactive = (): boolean => false
