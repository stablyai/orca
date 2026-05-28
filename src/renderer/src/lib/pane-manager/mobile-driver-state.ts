// Why: presence-based driver state for the mobile-presence lock. Mirrors
// the runtime's `currentDriver` map. Keyed by ptyId. Updated by an IPC
// listener (onTerminalDriverChanged) wired from main.
//
// While `getDriverForPty(ptyId).kind === 'mobile'` the renderer:
//   - drops xterm.onData (input lock)
//   - drops xterm.onResize (resize lock)
//   - mounts the lock banner with the "Take back" affordance
//
// See docs/mobile-presence-lock.md.

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

export function getDriverForPty(ptyId: string): DriverState {
  return driverByPtyId.get(ptyId) ?? { kind: 'idle' }
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

  // Why: startup hydration can arrive after TerminalPane has mounted. Notify
  // all affected PTYs so the pane-local overlay cannot miss an active lock.
  for (const ptyId of affectedPtyIds) {
    notifyChange({ ptyId, driver: getDriverForPty(ptyId) })
  }
}
