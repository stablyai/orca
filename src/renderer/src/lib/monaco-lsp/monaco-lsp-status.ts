import { useSyncExternalStore } from 'react'

/** Per-file LSP attachment state, keyed by absolute file path. Drives the
 *  editor header badge; 'starting' covers spawn + initialize round-trip. */
export type LspFileStatus = { state: 'starting' | 'running'; serverId: string | null }

const statusByFilePath = new Map<string, LspFileStatus>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function setLspFileStatus(filePath: string, status: LspFileStatus | null): void {
  if (status === null) {
    if (statusByFilePath.delete(filePath)) {
      emit()
    }
    return
  }
  const previous = statusByFilePath.get(filePath)
  if (previous?.state === status.state && previous.serverId === status.serverId) {
    return
  }
  statusByFilePath.set(filePath, status)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLspStatusForFile(filePath: string | null): LspFileStatus | null {
  return useSyncExternalStore(subscribe, () =>
    filePath ? (statusByFilePath.get(filePath) ?? null) : null
  )
}
