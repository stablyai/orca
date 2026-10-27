import { runProcess } from '@orca/process-host'
import {
  CHEAP_PS_ARGS,
  PS_MAX_BUFFER_BYTES,
  ProcessTableCaptureError,
  parseCheapProcessTableRows,
  type CheapProcessTableRow
} from './process-table-snapshot'
import {
  PS_TIMEOUT_MS,
  createProcessTableSnapshotReader,
  withEvidenceBudget
} from './process-table-snapshot-reader'
import { psLocaleEnvironment } from './ps-locale-environment'

/** Keep cheap captures separate: without tty=/command= they parse differently and cannot serve strict evidence readers. Share coalescing/TTL policy. */
const cheapProcessTableReader = createProcessTableSnapshotReader<CheapProcessTableRow[]>({
  runPs: async () => {
    const result = await runProcess({
      program: 'ps',
      args: CHEAP_PS_ARGS,
      env: psLocaleEnvironment(),
      timeoutMs: PS_TIMEOUT_MS,
      maxOutputBytes: PS_MAX_BUFFER_BYTES
    })
    // A ceiling hit is truncation, not absence: name it in the domain vocabulary.
    if (result.outputTruncated) {
      throw new ProcessTableCaptureError('capture_truncated')
    }
    if (result.timedOut) {
      throw new ProcessTableCaptureError('capture_timeout')
    }
    if (result.code !== 0) {
      throw new ProcessTableCaptureError(`ps_exit_${result.code ?? result.signal ?? 'unknown'}`)
    }
    return parseCheapProcessTableRows(result.stdout)
  },
  now: () => Date.now()
})

/** Bound stalled cheap reads so the full path can handle fallback instead of pinning a poll tick. */
export async function getCheapProcessTableSnapshot(): Promise<CheapProcessTableRow[]> {
  return withEvidenceBudget(cheapProcessTableReader.getSnapshot())
}

export function resetCheapProcessTableSnapshotForTests(): void {
  cheapProcessTableReader.reset()
}
