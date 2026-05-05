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
// Why: keyed by 'tabId:paneId' composite to avoid collisions when different
// tabs have panes with the same numeric ID (pane IDs are per-tab, not global).
const ptyIdByPaneKey = new Map<string, string>()

// Why: the override maps are plain JS — React components that read them
// (e.g. the desktop mobile-fit banner) have no way to know when entries
// change. This listener set lets TerminalPane subscribe for re-renders
// and trigger safeFit on affected panes.
type OverrideChangeEvent = {
  ptyId: string
  mode: 'mobile-fit' | 'desktop-fit'
  cols: number
  rows: number
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
  if (mode === 'mobile-fit') {
    overridesByPtyId.set(ptyId, { mode, cols, rows })
  } else {
    overridesByPtyId.delete(ptyId)
  }
  notifyChange({ ptyId, mode, cols, rows })
}

export function getPaneIdsForPty(ptyId: string): number[] {
  const result: number[] = []
  for (const [key, boundPtyId] of ptyIdByPaneKey) {
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
    const ptyId = ptyIdByPaneKey.get(`${tabId}:${paneId}`)
    if (!ptyId) {
      return null
    }
    return overridesByPtyId.get(ptyId) ?? null
  }
  return null
}

export function bindPanePtyId(paneId: number, ptyId: string | null, tabId?: string): void {
  if (tabId) {
    const key = `${tabId}:${paneId}`
    if (ptyId) {
      ptyIdByPaneKey.set(key, ptyId)
    } else {
      ptyIdByPaneKey.delete(key)
    }
  }
}

export function unbindPane(paneId: number, tabId?: string): void {
  if (tabId) {
    ptyIdByPaneKey.delete(`${tabId}:${paneId}`)
  }
}

export function hydrateOverrides(
  overrides: { ptyId: string; mode: 'mobile-fit'; cols: number; rows: number }[]
): void {
  overridesByPtyId.clear()
  for (const o of overrides) {
    overridesByPtyId.set(o.ptyId, { mode: o.mode, cols: o.cols, rows: o.rows })
  }
}

export function getAllOverrides(): Map<string, FitOverride> {
  return new Map(overridesByPtyId)
}
