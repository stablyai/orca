import type { ManagedPaneInternal } from './pane-manager-types'

/** Retry a pane after a few transient losses, but stop retrying a persistently unstable context. */
export const WEBGL_CONTEXT_LOSS_RETRY_LIMIT = 3
export const WEBGL_CONTEXT_LOSS_RETRY_WINDOW_MS = 60_000

function recentContextLosses(pane: ManagedPaneInternal, now: number): number[] {
  const cutoff = now - WEBGL_CONTEXT_LOSS_RETRY_WINDOW_MS
  return (pane.webglContextLossTimestamps ?? []).filter((timestamp) => timestamp > cutoff)
}

export function prunePaneWebglContextLosses(pane: ManagedPaneInternal, now = Date.now()): number {
  const losses = recentContextLosses(pane, now)
  pane.webglContextLossTimestamps = losses
  return losses.length
}

export function countPaneWebglContextLosses(pane: ManagedPaneInternal, now = Date.now()): number {
  return recentContextLosses(pane, now).length
}

export function recordPaneWebglContextLoss(pane: ManagedPaneInternal, now = Date.now()): number {
  const losses = recentContextLosses(pane, now)
  losses.push(now)
  pane.webglContextLossTimestamps = losses
  return losses.length
}

export function canRetryPaneWebglAfterContextLoss(
  pane: ManagedPaneInternal,
  now = Date.now()
): boolean {
  return prunePaneWebglContextLosses(pane, now) < WEBGL_CONTEXT_LOSS_RETRY_LIMIT
}

export function resetPaneWebglContextLosses(pane: ManagedPaneInternal): void {
  pane.webglContextLossTimestamps = undefined
}
