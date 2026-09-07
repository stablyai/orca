import { clearPreHandlerPtyState, drainPreHandlerPtyData } from './pty-pre-handler-buffer'
import type { PtyDataMeta } from './pty-dispatcher'
import { PtyShutdownOutputQueue, type PtyShutdownOutputEvent } from './pty-shutdown-output-queue'

export const ptyDataHandlers = new Map<string, (data: string, meta?: PtyDataMeta) => void>()
export const ptyDataSidecars = new Map<string, Set<(data: string) => void>>()
export const ptyReplayHandlers = new Map<string, (data: string) => void>()
export const ptyExitHandlers = new Map<string, (code: number) => void>()
export const ptyTeardownHandlers = new Map<string, () => void>()
export const ptyShutdownLifecycleHandlers = new Map<
  string,
  { pause: () => void; rollback: () => void; commit: () => void }
>()

export type PtyDataHandlerShutdownSnapshot = {
  ptyId: string
  dataHandler?: (data: string, meta?: PtyDataMeta) => void
  replayHandler?: (data: string) => void
  teardownHandler?: () => void
  commit: () => void
  rollback: () => void
}

type PendingPtyHandlerShutdown = {
  owners: number
  committed: boolean
  outputQueue: PtyShutdownOutputQueue
  dataHandler?: (data: string, meta?: PtyDataMeta) => void
  replayHandler?: (data: string) => void
  teardownHandler?: () => void
  lifecycleHandler?: { pause: () => void; rollback: () => void; commit: () => void }
}

const pendingPtyHandlerShutdowns = new Map<string, PendingPtyHandlerShutdown>()
const rolledBackShutdownEvents = new Map<string, PtyShutdownOutputQueue>()
const ROLLED_BACK_SHUTDOWN_REPLAY_MAX_PTYS = 64

/** Suspend delivery until every overlapping shutdown owner commits or rolls back. */
export function unregisterPtyDataHandlers(ptyIds: string[]): PtyDataHandlerShutdownSnapshot[] {
  const snapshots: PtyDataHandlerShutdownSnapshot[] = []
  for (const id of ptyIds) {
    let pending = pendingPtyHandlerShutdowns.get(id)
    if (pending) {
      pending.owners += 1
    } else {
      const outputQueue = rolledBackShutdownEvents.get(id) ?? new PtyShutdownOutputQueue()
      rolledBackShutdownEvents.delete(id)
      pending = {
        owners: 1,
        committed: false,
        outputQueue,
        dataHandler: ptyDataHandlers.get(id),
        replayHandler: ptyReplayHandlers.get(id),
        teardownHandler: ptyTeardownHandlers.get(id),
        lifecycleHandler: ptyShutdownLifecycleHandlers.get(id)
      }
      pendingPtyHandlerShutdowns.set(id, pending)
      pending.lifecycleHandler?.pause()
    }
    let settled = false
    const settle = (committed: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      settlePtyDataHandlerShutdown(id, committed)
    }
    snapshots.push({
      ptyId: id,
      dataHandler: ptyDataHandlers.get(id),
      replayHandler: ptyReplayHandlers.get(id),
      teardownHandler: ptyTeardownHandlers.get(id),
      commit: () => settle(true),
      rollback: () => settle(false)
    })
  }
  return snapshots
}

export function restorePtyDataHandlersAfterFailedShutdown(
  snapshots: readonly PtyDataHandlerShutdownSnapshot[]
): void {
  for (const snapshot of snapshots) {
    snapshot.rollback?.()
  }
}

export function isPtyDataHandlerShutdownPending(ptyId: string): boolean {
  return pendingPtyHandlerShutdowns.has(ptyId)
}

export function bufferPtyShutdownReplayData(ptyId: string, data: string): boolean {
  return bufferPtyShutdownOutput(ptyId, { kind: 'replay', data })
}

export function bufferPtyShutdownData(ptyId: string, data: string, meta?: PtyDataMeta): boolean {
  return bufferPtyShutdownOutput(ptyId, { kind: 'data', data, meta })
}

function bufferPtyShutdownOutput(ptyId: string, event: PtyShutdownOutputEvent): boolean {
  const pending = pendingPtyHandlerShutdowns.get(ptyId)
  if (!pending) {
    return false
  }
  pending.outputQueue.enqueue(event)
  return true
}

export function drainRolledBackPtyShutdownData(ptyId: string): void {
  if (pendingPtyHandlerShutdowns.has(ptyId)) {
    return
  }
  const outputQueue = rolledBackShutdownEvents.get(ptyId)
  const dataHandler = ptyDataHandlers.get(ptyId)
  const replayHandler = ptyReplayHandlers.get(ptyId)
  if (!outputQueue || !dataHandler || !replayHandler) {
    return
  }
  rolledBackShutdownEvents.delete(ptyId)
  outputQueue.drain((event) => deliverShutdownEvent(ptyId, event, dataHandler, replayHandler))
}

function settlePtyDataHandlerShutdown(ptyId: string, committed: boolean): void {
  const pending = pendingPtyHandlerShutdowns.get(ptyId)
  if (!pending) {
    return
  }
  pending.committed ||= committed
  pending.owners -= 1
  if (pending.owners > 0) {
    return
  }
  pendingPtyHandlerShutdowns.delete(ptyId)
  if (pending.committed) {
    rolledBackShutdownEvents.delete(ptyId)
    pending.outputQueue.discard()
    pending.lifecycleHandler?.commit()
    deleteCapturedHandler(ptyDataHandlers, ptyId, pending.dataHandler)
    deleteCapturedHandler(ptyReplayHandlers, ptyId, pending.replayHandler)
    deleteCapturedHandler(ptyTeardownHandlers, ptyId, pending.teardownHandler)
    deleteCapturedHandler(ptyShutdownLifecycleHandlers, ptyId, pending.lifecycleHandler)
    clearPreHandlerPtyState(ptyId)
    return
  }
  pending.lifecycleHandler?.rollback()
  drainPreHandlerPtyData(ptyId, (data, meta) => {
    ptyDataHandlers.get(ptyId)?.(data, meta)
    const sidecars = ptyDataSidecars.get(ptyId)
    for (const sidecar of sidecars ? Array.from(sidecars) : []) {
      sidecar(data)
    }
  })
  const dataHandler = ptyDataHandlers.get(ptyId)
  const replayHandler = ptyReplayHandlers.get(ptyId)
  if (dataHandler && replayHandler) {
    pending.outputQueue.drain((event) =>
      deliverShutdownEvent(ptyId, event, dataHandler, replayHandler)
    )
  } else if (pending.outputQueue.length > 0) {
    // Why: a hidden pane can detach during the RPC; retain rollback output until both ordered channels reattach.
    rolledBackShutdownEvents.set(ptyId, pending.outputQueue)
    while (rolledBackShutdownEvents.size > ROLLED_BACK_SHUTDOWN_REPLAY_MAX_PTYS) {
      const oldestPtyId = rolledBackShutdownEvents.keys().next().value
      if (typeof oldestPtyId !== 'string') {
        break
      }
      rolledBackShutdownEvents.delete(oldestPtyId)
    }
  }
}

function deleteCapturedHandler<T>(
  map: Map<string, T>,
  ptyId: string,
  captured: T | undefined
): void {
  if (captured !== undefined && map.get(ptyId) === captured) {
    map.delete(ptyId)
  }
}

function deliverShutdownEvent(
  ptyId: string,
  event: PtyShutdownOutputEvent,
  dataHandler: (data: string, meta?: PtyDataMeta) => void,
  replayHandler: (data: string) => void
): void {
  if (event.kind === 'replay') {
    replayHandler(event.data)
    return
  }
  dataHandler(event.data, event.meta)
  for (const sidecar of Array.from(ptyDataSidecars.get(ptyId) ?? [])) {
    sidecar(event.data)
  }
}
