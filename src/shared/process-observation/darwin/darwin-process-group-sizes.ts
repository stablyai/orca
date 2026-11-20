import { monotonicNow } from '../../concurrency/deadline-settle-notifier'
import { PS_TIMEOUT_MS } from '../tables/process-table-ps-capture'
import {
  createProcessTableSnapshotReader,
  withEvidenceBudget
} from '../tables/process-table-snapshot-reader'
import { ProcessTableCaptureError } from '../tables/process-table-snapshot'
import { loadLibprocAddon } from './libproc-addon'
import {
  isNativeReaderHealthy,
  readFreshNativeTable,
  registerNativeRequest
} from './libproc-native-reads'

// kinfo_proc only, no argv: a fraction of a full capture, shared by every pane polled in the same round.
const processGroupSizesReader = createProcessTableSnapshotReader<ReadonlyMap<number, number>>({
  runPs: async () => {
    const addon = loadLibprocAddon()
    if (!addon || !isNativeReaderHealthy()) {
      throw new ProcessTableCaptureError('native_reader_unavailable')
    }
    const rows = await readFreshNativeTable(
      addon,
      { command: false },
      registerNativeRequest(),
      monotonicNow() + PS_TIMEOUT_MS
    )
    if (!Array.isArray(rows)) {
      throw new ProcessTableCaptureError('native_read_failed')
    }
    const sizes = new Map<number, number>()
    for (const row of rows) {
      sizes.set(row.pgid, (sizes.get(row.pgid) ?? 0) + 1)
    }
    return sizes
  },
  now: () => Date.now()
})

/** Members of every process group on this Mac; rejects when the native reader cannot say. */
export function getDarwinProcessGroupSizes(): Promise<ReadonlyMap<number, number>> {
  return withEvidenceBudget(processGroupSizesReader.getSnapshot())
}

export function resetDarwinProcessGroupSizesForTests(): void {
  processGroupSizesReader.reset()
}
