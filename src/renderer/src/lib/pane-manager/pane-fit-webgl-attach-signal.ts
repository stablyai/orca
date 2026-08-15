import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'

/**
 * Why an indirection: the fit path must offer a WebGL reattach opportunity on
 * every successful fit (event-anchored recovery — a resize or late mount is the
 * moment a DOM-stuck pane can heal), but pane-webgl-renderer already imports
 * pane-fit, so pane-fit cannot import it back. The renderer registers here.
 */
type PaneFitWebglAttachHook = (pane: ManagedPaneInternal) => void

let hook: PaneFitWebglAttachHook | null = null

export function setPaneFitWebglAttachHook(next: PaneFitWebglAttachHook | null): void {
  hook = next
}

export function notifyPaneFitSucceeded(pane: ManagedPane): void {
  try {
    hook?.(pane as ManagedPaneInternal)
  } catch {
    /* ignore — a reattach failure must not fail the fit that triggered it */
  }
}
