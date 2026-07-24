import type { RemoteServerUpdateEntry } from './remote-server-update-coordinator'
import { forEachWithConcurrency } from '../../../shared/map-with-concurrency'

export const REMOTE_SERVER_CHECK_CONCURRENCY = 4

export async function runRemoteServerUpdateBatch(
  entries: readonly RemoteServerUpdateEntry[],
  maxConcurrent: number,
  worker: (entry: RemoteServerUpdateEntry) => Promise<void>
): Promise<void> {
  await forEachWithConcurrency(entries, maxConcurrent, worker)
}

export async function runRemoteServerCheckBatch<T>(
  entries: readonly T[],
  worker: (entry: T) => Promise<void>
): Promise<void> {
  await forEachWithConcurrency(entries, REMOTE_SERVER_CHECK_CONCURRENCY, async (entry) => {
    try {
      await worker(entry)
    } catch {
      // One unreachable server must not suppress checks for the rest.
    }
  })
}
