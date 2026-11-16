import { PrioritySemaphore } from '../../../../../shared/concurrency/priority-semaphore'
import { MAX_CONCURRENT_FILE_RANGE_READS } from '../../../../../shared/file-content/file-range-read'

const slotsByEnvironment = new Map<string, PrioritySemaphore>()

/** Runs one range read when its host has a free slot; every reader of that host shares the slots. */
export async function withRemoteRangeReadSlot<T>(
  environmentId: string,
  read: () => Promise<T>
): Promise<T> {
  let slots = slotsByEnvironment.get(environmentId)
  if (!slots) {
    slots = new PrioritySemaphore(MAX_CONCURRENT_FILE_RANGE_READS)
    slotsByEnvironment.set(environmentId, slots)
  }
  const release = await slots.acquire(0)
  try {
    return await read()
  } finally {
    release()
  }
}
