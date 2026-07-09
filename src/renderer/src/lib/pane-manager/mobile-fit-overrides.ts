// Why: fit holds are runtime-owned state that the renderer must respect.
// mobile-fit: phone owns the grid. remote-desktop-fit: another desktop client
// owns the grid (multi-client size arbitration). In both cases this client
// parks xterm at the held dims and must not auto-fit/reassert the PTY.

export type FitHoldMode = 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'

type FitOverride = {
  mode: 'mobile-fit' | 'remote-desktop-fit'
  cols: number
  rows: number
}

const overridesByPtyId = new Map<string, FitOverride>()
// Why: this is an in-memory renderer fit binding, not an agent paneKey.
// Numeric pane ids are valid here because fit overrides never cross replay.
const ptyIdByFitBindingKey = new Map<string, string>()
// Why: remote-desktop-fit parks non-owners. Detect intentional local layout
// change (splitter drag) by comparing successive FitAddon proposals — only
// then unpark and reclaim size control. Keyed per pane binding (leafId), not
// ptyId: one PTY can be shown in multiple panes with different grids; a
// per-pty baseline would treat sibling panes as "user dragged".
const lastProposedByBindingKey = new Map<string, { cols: number; rows: number }>()

function fitBindingKey(tabId: string, paneId: number): string {
  return `${tabId}:${paneId}`
}

// Why: the override maps are plain JS — React components that read them
// (e.g. the desktop mobile-fit banner) have no way to know when entries
// change. This listener set lets TerminalPane subscribe for re-renders
// and trigger safeFit on affected panes.
type OverrideChangeEvent = {
  ptyId: string
  mode: FitHoldMode
  cols: number
  rows: number
  // Why: the dimensions the PTY was at *before* this event fired. For a
  // desktop-fit transition this is the prior hold cols/rows so listeners can
  // check whether xterm is still stuck at foreign dims and needs the
  // safety-net resize, vs. already moved on (e.g. user resized the desktop
  // pane while another client was active).
  priorCols: number | null
  priorRows: number | null
}
type OverrideChangeListener = (event: OverrideChangeEvent) => void
const changeListeners = new Set<OverrideChangeListener>()

export function onOverrideChange(listener: OverrideChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyChange(event: OverrideChangeEvent): void {
  for (const listener of changeListeners) {
    listener(event)
  }
}

export function setFitOverride(
  ptyId: string,
  mode: FitHoldMode,
  cols: number,
  rows: number
): void {
  const prior = overridesByPtyId.get(ptyId) ?? null
  if (mode === 'mobile-fit' || mode === 'remote-desktop-fit') {
    const holdChanged =
      !prior || prior.mode !== mode || prior.cols !== cols || prior.rows !== rows
    overridesByPtyId.set(ptyId, { mode, cols, rows })
    // Why: a newly applied (or dim-changed) hold must re-baseline every pane;
    // stale last-proposed from a prior hold would look like a drag on first fit.
    if (holdChanged) {
      lastProposedByBindingKey.clear()
    }
  } else {
    overridesByPtyId.delete(ptyId)
    lastProposedByBindingKey.clear()
  }
  notifyChange({
    ptyId,
    mode,
    cols,
    rows,
    priorCols: prior?.cols ?? null,
    priorRows: prior?.rows ?? null
  })
}

/**
 * True when a remote-desktop-fit park should release because this pane's
 * geometry changed since its last measurement (user dragged a splitter /
 * resized the window). First observation for a binding only records baseline.
 *
 * @param bindingKey Stable per-pane key (prefer leafId). Must not be ptyId —
 *   multiple panes can bind the same PTY at different grids.
 */
export function shouldTakeDesktopSizeControl(
  bindingKey: string,
  ptyId: string,
  proposed: { cols: number; rows: number } | null
): boolean {
  if (!bindingKey || !proposed || proposed.cols <= 0 || proposed.rows <= 0) {
    return false
  }
  const override = overridesByPtyId.get(ptyId)
  if (!override || override.mode !== 'remote-desktop-fit') {
    lastProposedByBindingKey.set(bindingKey, proposed)
    return false
  }
  const last = lastProposedByBindingKey.get(bindingKey)
  lastProposedByBindingKey.set(bindingKey, proposed)
  if (!last) {
    return false
  }
  return last.cols !== proposed.cols || last.rows !== proposed.rows
}

export function getPaneIdsForPty(ptyId: string): number[] {
  const result: number[] = []
  for (const [key, boundPtyId] of ptyIdByFitBindingKey) {
    if (boundPtyId === ptyId) {
      const paneId = Number(key.split(':').pop())
      if (!Number.isNaN(paneId)) {
        result.push(paneId)
      }
    }
  }
  return result
}

export function getFitOverrideForPty(ptyId: string): FitOverride | null {
  return overridesByPtyId.get(ptyId) ?? null
}

export function getFitOverrideForPane(paneId: number, tabId?: string): FitOverride | null {
  if (tabId) {
    const ptyId = ptyIdByFitBindingKey.get(fitBindingKey(tabId, paneId))
    if (!ptyId) {
      return null
    }
    return overridesByPtyId.get(ptyId) ?? null
  }
  return null
}

export function bindPanePtyId(paneId: number, ptyId: string | null, tabId?: string): void {
  if (tabId) {
    const key = fitBindingKey(tabId, paneId)
    if (ptyId) {
      ptyIdByFitBindingKey.set(key, ptyId)
    } else {
      ptyIdByFitBindingKey.delete(key)
    }
  }
}

export function unbindPane(paneId: number, tabId?: string): void {
  if (tabId) {
    ptyIdByFitBindingKey.delete(fitBindingKey(tabId, paneId))
  }
}

export function hydrateOverrides(
  overrides: {
    ptyId: string
    mode: 'mobile-fit' | 'remote-desktop-fit'
    cols: number
    rows: number
  }[]
): void {
  const previous = new Map(overridesByPtyId)
  overridesByPtyId.clear()
  lastProposedByBindingKey.clear()
  for (const o of overrides) {
    overridesByPtyId.set(o.ptyId, { mode: o.mode, cols: o.cols, rows: o.rows })
  }

  // Why: hydration can complete after terminal panes mount during reload. Notify
  // readers so held phone-fit overlays appear even without a fresh IPC event.
  for (const [ptyId, override] of overridesByPtyId) {
    const prior = previous.get(ptyId) ?? null
    notifyChange({
      ptyId,
      mode: override.mode,
      cols: override.cols,
      rows: override.rows,
      priorCols: prior?.cols ?? null,
      priorRows: prior?.rows ?? null
    })
    previous.delete(ptyId)
  }

  for (const [ptyId, prior] of previous) {
    notifyChange({
      ptyId,
      mode: 'desktop-fit',
      cols: 0,
      rows: 0,
      priorCols: prior.cols,
      priorRows: prior.rows
    })
  }
}

export function getAllOverrides(): Map<string, FitOverride> {
  return new Map(overridesByPtyId)
}
