import { monotonicNow } from '../../concurrency/deadline-settle-notifier'
import { PS_TIMEOUT_MS } from '../tables/process-table-ps-capture'
import { ProcessTableCaptureError } from '../tables/process-table-snapshot'
import { loadLibprocAddon } from './libproc-addon'
import {
  isNativeReaderHealthy,
  readFreshNativeTable,
  registerNativeRequest
} from './libproc-native-reads'

/** Members of every process group, from one kinfo_proc read (no argv); rejects when the native reader cannot say. */
export async function readDarwinProcessGroupSizes(): Promise<ReadonlyMap<number, number>> {
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
}
