// Non-owners hold xterm at the phone/desktop owner’s PTY grid to avoid passive-fit resize wars.

export type FitHoldMode = 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'

type FitOverride = {
  mode: 'mobile-fit' | 'remote-desktop-fit'
  cols: number
  rows: number
}

const overridesByPtyId = new Map<string, FitOverride>()
// These renderer-only pane IDs never cross replay, so numeric IDs remain valid.
const ptyIdByFitBindingKey = new Map<string, string>()

function fitBindingKey(tabId: string, paneId: number): string {
  return `${tabId}:${paneId}`
}

// Publish plain-map changes so panes can update lock overlays and safely refit affected terminals.
type OverrideChangeEvent = {
  ptyId: string
  mode: FitHoldMode
  cols: number
  rows: number
  // Carry pre-event dimensions so listeners can distinguish stale phone-fit xterm size from newer user resizing.
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

export function setFitOverride(ptyId: string, mode: FitHoldMode, cols: number, rows: number): void {
  const prior = overridesByPtyId.get(ptyId) ?? null
  if (mode === 'mobile-fit' || mode === 'remote-desktop-fit') {
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

export function replaceFitOverridePtyId(replacedPtyId: string, ptyId: string): void {
  const replaced = overridesByPtyId.get(replacedPtyId)
  if (!replaced) {
    return
  }
  // Keep hold across handle rotation until replacement authority arrives; remove unreachable old-handle entries.
  if (!overridesByPtyId.has(ptyId)) {
    setFitOverride(ptyId, replaced.mode, replaced.cols, replaced.rows)
  }
  setFitOverride(replacedPtyId, 'desktop-fit', replaced.cols, replaced.rows)
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
  for (const o of overrides) {
    overridesByPtyId.set(o.ptyId, { mode: o.mode, cols: o.cols, rows: o.rows })
  }

  // Hydration can follow pane mount; notify overlays even without another live IPC event.
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

export function getMobileFitOverridePtyIds(): string[] {
  return [...overridesByPtyId].flatMap(([ptyId, override]) =>
    override.mode === 'mobile-fit' ? [ptyId] : []
  )
}
