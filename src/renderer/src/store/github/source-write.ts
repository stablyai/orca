import type { Repo } from '../../../../shared/repo-types'
import type { CollectionOwner } from './source-preference-ownership'

/** One optimistic source-preference write for a repo/host; `finish` is the single end of its lifetime. */
export type SourceWrite = {
  repo: Repo
  preference: Repo['issueSourcePreference']
  acknowledged: Repo['issueSourcePreference']
  pending: boolean
  settled: Promise<boolean>
  finish: (saved: boolean) => void
  owner: CollectionOwner | undefined
  /** The owner's readback count when this write failed; the host may still have saved it until a newer row says. */
  failed?: number
  /** In-memory wake callbacks of detachable waits; cleared when the write ends. */
  waiters: Set<() => void>
}

export function createSourceWrite(
  fields: Pick<SourceWrite, 'repo' | 'owner' | 'preference' | 'acknowledged'>
): SourceWrite {
  const deferred = Promise.withResolvers<boolean>()
  const waiters = new Set<() => void>()
  return {
    ...fields,
    pending: true,
    settled: deferred.promise,
    waiters,
    finish: (saved) => {
      deferred.resolve(saved)
      for (const wake of waiters) {
        wake()
      }
      waiters.clear()
    }
  }
}

/** Resolves when any of the writes ends or the signal aborts, leaving no observer on either. */
export function waitForWriteEnd(writes: readonly SourceWrite[], signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const wake = () => {
      for (const write of writes) {
        write.waiters.delete(wake)
      }
      signal?.removeEventListener('abort', wake)
      resolve()
    }
    for (const write of writes) {
      write.waiters.add(wake)
    }
    signal?.addEventListener('abort', wake)
  })
}
