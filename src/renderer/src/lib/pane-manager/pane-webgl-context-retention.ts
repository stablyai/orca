import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import type { ManagedPaneInternal } from './pane-manager-types'

// Why: workspace switches used to dispose every hidden pane's WebGL context
// and recreate it on return — ~5ms on macOS but 100-500ms per pane on Windows
// (ANGLE → D3D11), paid synchronously on the switch path. With the app-level
// context budget raised to 128 (#7064), hidden panes can keep their contexts;
// this LRU cap only bounds hidden-pane GPU memory. Sized for the reported hot
// set (~10-16 worktrees × ~2 terminals) while staying far under the budget.
export const RETAINED_WEBGL_PANE_CAP = 32

/** Windows-only: context re-creation is cheap on macOS/Linux GL, so hidden
 *  panes there keep the long-proven dispose-on-hide behavior instead of
 *  paying retention's GPU-memory cost for no perceptible switch latency win. */
export function shouldRetainSuspendedWebglContexts(): boolean {
  return getRendererAppPlatform() === 'win32'
}

// Insertion order doubles as LRU order: re-retaining deletes + re-adds.
const retainedPanes = new Set<ManagedPaneInternal>()

/**
 * Registers a suspended pane's live WebGL context for retention across
 * hide/show. Returns panes evicted by the cap — the caller disposes them
 * (dependency points that way to avoid a cycle with pane-webgl-renderer).
 */
export function retainSuspendedWebglPane(pane: ManagedPaneInternal): ManagedPaneInternal[] {
  if (!pane.webglAddon) {
    return []
  }
  retainedPanes.delete(pane)
  retainedPanes.add(pane)
  const evicted: ManagedPaneInternal[] = []
  while (retainedPanes.size > RETAINED_WEBGL_PANE_CAP) {
    const oldest = retainedPanes.values().next().value
    if (!oldest) {
      break
    }
    retainedPanes.delete(oldest)
    evicted.push(oldest)
  }
  return evicted
}

export function unretainWebglPane(pane: ManagedPaneInternal): void {
  retainedPanes.delete(pane)
}

export function retainedWebglPaneCount(): number {
  return retainedPanes.size
}

/** Drops all retention entries without disposing anything (test isolation). */
export function clearRetainedWebglPanes(): void {
  retainedPanes.clear()
}
