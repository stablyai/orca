import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'

// Offer WebGL recovery on every successful fit without cycling pane-fit ↔ pane-webgl-renderer; the renderer registers here.
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
