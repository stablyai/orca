import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import { registerRendererMemoryProfileContributor } from '../renderer-memory-profile'
import type { PaneRenderingDiagnostics } from './pane-manager-types'

type RegisteredPaneManager = {
  resetWebglTextureAtlases(): void
  clearWebglTextureAtlases?: () => void
  presentForcedViewports?: () => void
  fitAllPanes?: () => void
  refreshAllPanes?: () => void
  getRenderingDiagnostics?: () => PaneRenderingDiagnostics[]
  getPanes?: (limit?: number) => { id: number; terminal: unknown }[]
  getPaneCount?: () => number
  isVisibleForAtlasRecovery?: () => boolean
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

export function resetAndRefreshAllTerminalWebglAtlases(reason?: string): void {
  // Why: the atlas wipe is the heavy recovery path; recording it lets a freeze
  // report show whether a post-wake repaint actually ran. Silent breadcrumb.
  const recoveryManagers = Array.from(liveManagers).filter(
    (manager) => manager.isVisibleForAtlasRecovery?.() !== false
  )
  recordTerminalWebglDiagnostic('webgl-atlas-reset', {
    managers: recoveryManagers.length,
    mountedManagers: liveManagers.size,
    ...(reason ? { reason } : {})
  })
  const resetManagers: RegisteredPaneManager[] = []
  // Why: clearTextureAtlas() is module-global. Clearing then presenting per
  // pane interleaves a present against generation N with the next pane's wipe
  // to N+1, so the first synchronized-output column keeps pre-hide footer pixels.
  // Wipe every recovered atlas first; present only once the generation is final.
  for (const manager of recoveryManagers) {
    try {
      if (manager.clearWebglTextureAtlases) {
        manager.clearWebglTextureAtlases()
      } else {
        manager.resetWebglTextureAtlases()
      }
      resetManagers.push(manager)
    } catch {
      // Why: recovery is best-effort during pane teardown; a disposed manager
      // should not block sibling terminals from rebuilding and repainting.
    }
  }
  for (const manager of resetManagers) {
    try {
      if (manager.presentForcedViewports) {
        manager.presentForcedViewports()
      } else {
        manager.refreshAllPanes?.()
      }
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
 * Live pane census: managers (≈ terminal tabs) and the panes they hold.
 *
 * Why: this is the population number crash reports have been inferring from
 * breadcrumb multiplicity, which never worked — `pane.id` restarts at 1 per
 * manager, so N panes and one looping pane are indistinguishable in the ring.
 * Measure it instead.
 */
export function getLivePaneCensus(): { managers: number; panes: number } {
  let panes = 0
  for (const manager of liveManagers) {
    try {
      panes += manager.getPaneCount?.() ?? manager.getPanes?.().length ?? 0
    } catch {
      // Why: a manager mid-teardown must not sink the count for the rest.
    }
  }
  return { managers: liveManagers.size, panes }
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

// Rough xterm BufferLine cost (3 uint32 per cell + object overhead); ranking
// matters, not accuracy.
const BYTES_PER_TERMINAL_CELL = 16
const BYTES_PER_KILOBYTE = 1024
const MANAGER_SAMPLE_LIMIT = 64
const PANE_SAMPLE_LIMIT = 256

type BufferedTerminal = {
  cols?: number
  buffer?: { active?: { length?: number } }
}

/**
 * Memory-profile census over live pane managers. Mounted panes are the
 * dominant highwater cost the store census can't see (97b9e86d: heap ~1.3GB
 * while all store slices summed to ~15MB) — eviction-exempt panes accumulate
 * mounted forever, each retaining rows x cols of scrollback.
 */
export function getLivePaneMemoryProfileCounts(): Record<string, number> {
  let sampledManagers = 0
  let paneCount = 0
  let sampledPanes = 0
  let sampledBufferBytes = 0
  for (const manager of liveManagers) {
    if (sampledManagers >= MANAGER_SAMPLE_LIMIT) {
      break
    }
    sampledManagers += 1
    const remainingPaneSamples = Math.max(0, PANE_SAMPLE_LIMIT - sampledPanes)
    let managerPanes: { id: number; terminal: unknown }[] = []
    try {
      if (remainingPaneSamples > 0) {
        managerPanes = manager.getPanes?.(remainingPaneSamples) ?? []
      }
    } catch {
      managerPanes = []
    }
    let managerPaneCount: number | undefined
    try {
      managerPaneCount = manager.getPaneCount?.()
    } catch {
      managerPaneCount = undefined
    }
    paneCount +=
      typeof managerPaneCount === 'number' && Number.isFinite(managerPaneCount)
        ? Math.max(0, managerPaneCount)
        : managerPanes.length
    const panesToInspect = Math.min(managerPanes.length, remainingPaneSamples)
    for (let index = 0; index < panesToInspect; index += 1) {
      const pane = managerPanes[index]
      const terminal = pane.terminal as BufferedTerminal | null | undefined
      const rows = terminal?.buffer?.active?.length
      const cols = terminal?.cols
      if (
        typeof rows === 'number' &&
        Number.isFinite(rows) &&
        rows > 0 &&
        typeof cols === 'number' &&
        Number.isFinite(cols) &&
        cols > 0
      ) {
        sampledBufferBytes += rows * cols * BYTES_PER_TERMINAL_CELL
      }
    }
    sampledPanes += panesToInspect
  }
  const managerScale = sampledManagers === 0 ? 0 : liveManagers.size / sampledManagers
  const estPanes = Math.round(paneCount * managerScale)
  const paneScale = sampledPanes === 0 ? 0 : estPanes / sampledPanes
  return {
    managers: liveManagers.size,
    estPanes,
    estBufferKB: Math.round((sampledBufferBytes * paneScale) / BYTES_PER_KILOBYTE)
  }
}

// Why here: contributors push in (crash-diagnostics stays a leaf); same-name
// re-registration on dev HMR overwrites, so no disposal hook is needed.
registerRendererMemoryProfileContributor('terminals', getLivePaneMemoryProfileCounts)
