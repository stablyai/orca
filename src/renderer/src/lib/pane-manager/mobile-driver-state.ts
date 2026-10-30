// Mirror runtime PTY driver presence from IPC: mobile ownership locks xterm input/resize and shows Take back (mobile-presence-lock.md).

import type { RuntimeTerminalDriverState } from '../../../../shared/runtime-types'

export type DriverState = RuntimeTerminalDriverState

const driverByPtyId = new Map<string, DriverState>()

type DriverChangeEvent = {
  ptyId: string
  driver: DriverState
}
type DriverChangeListener = (event: DriverChangeEvent) => void
const changeListeners = new Set<DriverChangeListener>()

export function onDriverChange(listener: DriverChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyChange(event: DriverChangeEvent): void {
  for (const listener of changeListeners) {
    listener(event)
  }
}

export function setDriverForPty(ptyId: string, driver: DriverState): void {
  if (driver.kind === 'idle') {
    driverByPtyId.delete(ptyId)
  } else {
    driverByPtyId.set(ptyId, driver)
  }
  notifyChange({ ptyId, driver })
}

export function replaceDriverPtyId(replacedPtyId: string, ptyId: string): void {
  const replaced = driverByPtyId.get(replacedPtyId)
  if (!replaced) {
    return
  }
  // Preserve conservative locks across handle rotation without retaining every obsolete handle key.
  if (!driverByPtyId.has(ptyId)) {
    setDriverForPty(ptyId, replaced)
  }
  setDriverForPty(replacedPtyId, { kind: 'idle' })
}

export function getDriverForPty(ptyId: string): DriverState {
  return driverByPtyId.get(ptyId) ?? { kind: 'idle' }
}

export function getAllDrivers(): Map<string, DriverState> {
  return new Map(driverByPtyId)
}

export function isPtyLocked(ptyId: string): boolean {
  return driverByPtyId.get(ptyId)?.kind === 'mobile'
}

export function hydrateDrivers(drivers: { ptyId: string; driver: DriverState }[]): void {
  const affectedPtyIds = new Set(driverByPtyId.keys())
  driverByPtyId.clear()

  for (const { ptyId, driver } of drivers) {
    affectedPtyIds.add(ptyId)
    if (driver.kind !== 'idle') {
      driverByPtyId.set(ptyId, driver)
    }
  }

  // Notify all affected PTYs after hydration so already-mounted overlays cannot miss active mobile locks.
  for (const ptyId of affectedPtyIds) {
    notifyChange({ ptyId, driver: getDriverForPty(ptyId) })
  }
}
