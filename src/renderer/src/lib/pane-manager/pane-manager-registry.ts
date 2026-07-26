import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import type { PaneRenderingDiagnostics } from './pane-manager-types'

type RegisteredPaneManager = {
  resetWebglTextureAtlases(): void
  fitAllPanes?: () => void
  refreshAllPanes?: () => void
  getRenderingDiagnostics?: () => PaneRenderingDiagnostics[]
  getPanes?: () => { id: number; terminal: unknown }[]
}

const liveManagers = new Set<RegisteredPaneManager>()
const managerIds = new WeakMap<RegisteredPaneManager, number>()
let nextManagerId = 1

export function registerLivePaneManager(manager: RegisteredPaneManager): void {
  if (!managerIds.has(manager)) {
    managerIds.set(manager, nextManagerId++)
  }
  liveManagers.add(manager)
}

export function unregisterLivePaneManager(manager: RegisteredPaneManager): void {
  liveManagers.delete(manager)
}

/**
 * Resets the WebGL glyph atlases of every live pane manager, not just one.
 *
 * Why: @xterm/addon-webgl keeps a module-global atlas cache, so terminals with
 * identical font configs share one glyph texture atlas. Clearing it through a
 * single manager invalidates the cached glyph coordinates of every other
 * sharing terminal without rebuilding their render models, which paints them
 * as garbled glyphs. Recovery resets must therefore rebuild all terminals.
 */
export function resetAllTerminalWebglAtlases(): void {
  for (const manager of liveManagers) {
    try {
      manager.resetWebglTextureAtlases()
    } catch {
      // Why: stale WebGL recovery is best-effort during pane teardown; one
      // disposed manager should not prevent sibling terminals from repainting.
    }
  }
}

export function resetAndRefreshAllTerminalWebglAtlases(): void {
  // Why: the atlas wipe is the heavy recovery path; recording it lets a freeze
  // report show whether a post-wake repaint actually ran. Silent breadcrumb.
  recordTerminalWebglDiagnostic('webgl-atlas-reset', { managers: liveManagers.size })
  const resetManagers: RegisteredPaneManager[] = []
  for (const manager of liveManagers) {
    try {
      manager.resetWebglTextureAtlases()
      resetManagers.push(manager)
    } catch {
      // Why: recovery is best-effort during pane teardown; a disposed manager
      // should not block sibling terminals from rebuilding and repainting.
    }
  }
  for (const manager of resetManagers) {
    try {
      manager.refreshAllPanes?.()
    } catch {
      // Why: a pane can unmount between atlas reset and repaint; later
      // managers still need to repaint from their xterm buffers.
    }
  }
}

/**
 * Per-pane WebGL renderer state across all live managers, for the one-paste
 * freeze report. Lets a post-wake garble report show, per pane, whether it
 * held a live WebGL addon or had fallen back after a context loss — the state
 * that distinguishes "missed repaint" from "atlas corrupted".
 */
export function getAllPaneRenderingDiagnostics(): PaneRenderingDiagnostics[] {
  const all: PaneRenderingDiagnostics[] = []
  for (const manager of liveManagers) {
    try {
      const diagnostics = manager.getRenderingDiagnostics?.()
      if (diagnostics) {
        all.push(...diagnostics)
      }
    } catch {
      // Why: best-effort during teardown; one manager must not sink the report.
    }
  }
  return all
}

/**
 * Iterates every live pane for the render-desync sentinel. Weakly-held manager
 * ids stay stable when an earlier manager unregisters without retaining it.
 */
export function forEachLivePaneForDesyncSentinel(
  visit: (paneKey: string, pane: { id: number; terminal: unknown }) => void
): void {
  for (const manager of liveManagers) {
    const managerId = managerIds.get(manager)
    if (managerId == null) {
      continue
    }
    let panes: { id: number; terminal: unknown }[] = []
    try {
      panes = manager.getPanes?.() ?? []
    } catch {
      continue
    }
    for (const pane of panes) {
      try {
        visit(`m${managerId}:p${pane.id}`, pane)
      } catch {
        // Why: one pane's failure must not stop sentinel coverage of the rest.
      }
    }
  }
}

export function refitAndRefreshAllTerminalPanes(): void {
  for (const manager of liveManagers) {
    try {
      // Why: after bulk desktop restore, background panes may have correct
      // cols/rows but a stale xterm renderer until focus forces a repaint.
      manager.fitAllPanes?.()
      manager.refreshAllPanes?.()
    } catch {
      // Why: restore-all is best-effort across live managers during teardown.
    }
  }
}
