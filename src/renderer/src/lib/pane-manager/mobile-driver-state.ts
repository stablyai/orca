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

export type DriverState =
  | { kind: 'idle' }
  | { kind: 'desktop' }
  | { kind: 'mobile'; clientId: string }

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
