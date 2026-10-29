import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import { registerRendererMemoryProfileContributor } from '../renderer-memory-profile'
import type { PaneRenderingDiagnostics } from './pane-manager-types'

type RegisteredPaneManager = {
  resetWebglTextureAtlases(): void
  clearWebglTextureAtlases?: () => void
  presentViewports?: () => void
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
  // Record heavy atlas recovery so freeze reports distinguish a missing repaint from a completed post-wake attempt.
  const recoveryManagers = Array.from(liveManagers).filter(
    (manager) => manager.isVisibleForAtlasRecovery?.() !== false
  )
  recordTerminalWebglDiagnostic('webgl-atlas-reset', {
    managers: recoveryManagers.length,
    mountedManagers: liveManagers.size,
    ...(reason ? { reason } : {})
  })
  const resetManagers: RegisteredPaneManager[] = []
  // clearTextureAtlas is global: wipe all before presenting or later wipes invalidate earlier panes’ generation and preserve stale footer pixels.
  for (const manager of recoveryManagers) {
    try {
      if (manager.clearWebglTextureAtlases) {
        manager.clearWebglTextureAtlases()
      } else {
        manager.resetWebglTextureAtlases()
      }
      resetManagers.push(manager)
    } catch {
      // One disposed manager must not block sibling atlas recovery.
    }
  }
  for (const manager of resetManagers) {
    try {
      if (manager.presentViewports) {
        manager.presentViewports()
      } else {
        manager.refreshAllPanes?.()
      }
    } catch {
      // Panes may unmount between reset and repaint; continue with remaining managers.
    }
  }
}

/** Report each pane’s WebGL/DOM state so freeze reports distinguish missed repaint from atlas corruption/context loss. */
export function getAllPaneRenderingDiagnostics(): PaneRenderingDiagnostics[] {
  const all: PaneRenderingDiagnostics[] = []
  for (const manager of liveManagers) {
    try {
      const diagnostics = manager.getRenderingDiagnostics?.()
      if (diagnostics) {
        all.push(...diagnostics)
      }
    } catch {
      // One manager’s teardown must not sink the report.
    }
  }
  return all
}

/** Measure managers and panes directly; pane IDs restart per manager, so coalesced breadcrumb multiplicity cannot distinguish a population from one looping pane. */
export function getLivePaneCensus(): { managers: number; panes: number } {
  let panes = 0
  for (const manager of liveManagers) {
    try {
      panes += manager.getPaneCount?.() ?? manager.getPanes?.().length ?? 0
    } catch {
      // One manager’s teardown must not sink the census.
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
        // One pane’s failure must not stop sentinel coverage of others.
      }
    }
  }
}

export function refitAndRefreshAllTerminalPanes(): void {
  for (const manager of liveManagers) {
    try {
      // Background panes can have correct grids but stale renderers after bulk desktop restore.
      manager.fitAllPanes?.()
      manager.refreshAllPanes?.()
    } catch {
      // Continue restore-all across managers being torn down.
    }
  }
}

// Approximate BufferLine cost (three uint32/cell plus overhead); ranking matters more than precision.
const BYTES_PER_TERMINAL_CELL = 16
const BYTES_PER_KILOBYTE = 1024
const MANAGER_SAMPLE_LIMIT = 64
const PANE_SAMPLE_LIMIT = 256

type BufferedTerminal = {
  cols?: number
  buffer?: { active?: { length?: number } }
}

/** Include mounted scrollback in memory census: eviction-exempt panes can dominate heap while persisted store slices stay small. */
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

// Push into leaf crash-diagnostics to avoid cycles; HMR overwrites same-name contributors without disposal.
registerRendererMemoryProfileContributor('terminals', getLivePaneMemoryProfileCounts)
