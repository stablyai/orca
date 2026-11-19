import { cleanupPolicyOwnerKey as ownerKey } from './workspace-cleanup-write-journal'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  WorkspaceCleanupPolicyChange,
  WorkspaceCleanupPolicyRead
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import { createWorkspaceCleanupPolicyWrite } from './workspace-cleanup-policy-client'

type Write = ReturnType<typeof createWorkspaceCleanupPolicyWrite>
export type CleanupWriteResult = Awaited<ReturnType<Write['settle']>>
type PendingWrite = {
  phase: 'sending' | 'checking' | 'disconnected'
  result: Promise<CleanupWriteResult>
  resolve: (value: CleanupWriteResult) => void
  write: Write
  settlement?: Promise<void>
}
const pending = new Map<string, PendingWrite>()
const listeners = new Map<string, Set<() => void>>()
const notify = (key: string) => listeners.get(key)?.forEach((listener) => listener())

export function cleanupWritePhase(owner: RuntimeClientTarget) {
  return pending.get(ownerKey(owner))?.phase ?? 'idle'
}
export function subscribeCleanupWrite(owner: RuntimeClientTarget, listener: () => void) {
  const key = ownerKey(owner)
  const group = listeners.get(key) ?? new Set()
  listeners.set(key, group)
  group.add(listener)
  return () => {
    group.delete(listener)
    if (!group.size) {
      listeners.delete(key)
    }
  }
}
function complete(key: string, entry: PendingWrite, result: CleanupWriteResult) {
  if (pending.get(key) === entry) {
    entry.write.forget()
    pending.delete(key)
    entry.resolve(result)
    notify(key)
  }
}
function settle(key: string, entry: PendingWrite): Promise<void> {
  if (pending.get(key) !== entry) {
    return Promise.resolve()
  }
  if (entry.settlement) {
    return entry.settlement
  }
  entry.phase = 'checking'
  notify(key)
  const request = entry.write.settle().then((result) => complete(key, entry, result))
  entry.settlement = request
  void request
    .catch(() => {
      if (pending.get(key) === entry) {
        entry.phase = 'disconnected'
        entry.settlement = undefined
        notify(key)
      }
    })
    .finally(() => {
      if (entry.settlement === request) {
        entry.settlement = undefined
      }
    })
  return request
}
export function retryCleanupWrite(owner: RuntimeClientTarget): Promise<void> {
  const key = ownerKey(owner)
  const entry = pending.get(key)
  return entry ? settle(key, entry) : Promise.resolve()
}
export async function waitForCleanupWrite(owner: RuntimeClientTarget): Promise<void> {
  const key = ownerKey(owner)
  const entry = pending.get(key)
  if (entry) {
    if (entry.phase !== 'sending') {
      void settle(key, entry).catch(() => undefined)
    }
    await entry.result
  }
}
export function dispatchCleanupWrite(
  owner: RuntimeClientTarget,
  change: WorkspaceCleanupPolicyChange,
  read: WorkspaceCleanupPolicyRead
) {
  const key = ownerKey(owner)
  if (pending.has(key)) {
    throw new Error('workspace_cleanup_write_pending')
  }
  const result = Promise.withResolvers<CleanupWriteResult>()
  const entry: PendingWrite = {
    phase: 'sending',
    result: result.promise,
    resolve: result.resolve,
    write: createWorkspaceCleanupPolicyWrite(owner, change, read)
  }
  pending.set(key, entry)
  notify(key)
  void Promise.resolve().then(async () => {
    if (pending.get(key) !== entry) {
      return
    }
    try {
      await entry.write.send()
      if (pending.get(key) === entry) {
        complete(key, entry, await entry.write.readback())
      }
    } catch {
      void settle(key, entry).catch(() => undefined)
    }
  })
  return { result: entry.result, retire: () => settle(key, entry) }
}
