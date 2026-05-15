// Why: mobile-fit overrides are runtime-owned state that the renderer must
// respect. When a mobile client resizes a PTY to phone dimensions, the desktop
// renderer must not auto-fit that PTY back to desktop size. This module stores
// the override state and provides lookup for safeFit() and transport.resize().

type FitOverride = {
  mode: 'mobile-fit'
  cols: number
  rows: number
}

const overridesByPtyId = new Map<string, FitOverride>()
// Why: this is an in-memory renderer fit binding, not an agent paneKey.
// Numeric pane ids are valid here because fit overrides never cross replay.
const ptyIdByFitBindingKey = new Map<string, string>()

function fitBindingKey(tabId: string, paneId: number): string {
  return `${tabId}:${paneId}`
}

// Why: the override maps are plain JS — React components that read them
// (e.g. the desktop mobile-fit banner) have no way to know when entries
// change. This listener set lets TerminalPane subscribe for re-renders
// and trigger safeFit on affected panes.
type OverrideChangeEvent = {
  ptyId: string
  mode: 'mobile-fit' | 'desktop-fit'
  cols: number
  rows: number
  // Why: the dimensions the PTY was at *before* this event fired. For a
  // desktop-fit transition this is the prior mobile-fit cols/rows so
  // listeners can check whether xterm is still stuck at phone dims and
  // needs the safety-net resize, vs. already moved on (e.g. user resized
  // the desktop pane while mobile was active).
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
  mode: 'mobile-fit' | 'desktop-fit',
  cols: number,
  rows: number
): void {
  const prior = overridesByPtyId.get(ptyId) ?? null
  if (mode === 'mobile-fit') {
    overridesByPtyId.set(ptyId, { mode, cols, rows })
  } else {
    overridesByPtyId.delete(ptyId)
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
  overrides: { ptyId: string; mode: 'mobile-fit'; cols: number; rows: number }[]
): void {
  const previous = new Map(overridesByPtyId)
  overridesByPtyId.clear()
  for (const o of overrides) {
    overridesByPtyId.set(o.ptyId, { mode: o.mode, cols: o.cols, rows: o.rows })
  }

  // Why: hydration can complete after terminal panes mount during reload. Notify
  // readers so held phone-fit overlays appear even without a fresh IPC event.
  for (const [ptyId, override] of overridesByPtyId) {
    const prior = previous.get(ptyId) ?? null
    notifyChange({
      ptyId,
      mode: 'mobile-fit',
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
