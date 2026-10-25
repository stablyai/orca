import type { RemoteServerUpdateEntry } from './remote-server-update-coordinator'

export async function runRemoteServerUpdateBatch(
  entries: readonly RemoteServerUpdateEntry[],
  maxConcurrent: number,
  worker: (entry: RemoteServerUpdateEntry) => Promise<void>
): Promise<void> {
  const pending = [...entries]
  const workers = Array.from(
    { length: Math.min(Math.max(1, maxConcurrent), pending.length) },
    async () => {
      while (pending.length > 0) {
        const entry = pending.shift()
        if (entry) {
          await worker(entry)
        }
      }
    }
  )
  const results = await Promise.allSettled(workers)
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') {
    throw failure.reason
  }
}
