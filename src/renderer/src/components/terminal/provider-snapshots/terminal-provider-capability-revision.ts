import { invalidateTerminalParkingPtyInputs } from '@/store/terminals/parking/terminal-parking-input-owner'
let capabilityRevision = 0
const capabilityRevisionListeners = new Set<() => void>()

export function publishTerminalProviderCapabilityChange(ptyIds?: Iterable<string>): void {
  invalidateTerminalParkingPtyInputs(ptyIds)
  capabilityRevision += 1
  for (const listener of capabilityRevisionListeners) {
    listener()
  }
}

export function subscribeTerminalProviderSnapshotCapability(listener: () => void): () => void {
  capabilityRevisionListeners.add(listener)
  return () => capabilityRevisionListeners.delete(listener)
}

export function getTerminalProviderSnapshotCapabilityRevision(): number {
  return capabilityRevision
}
