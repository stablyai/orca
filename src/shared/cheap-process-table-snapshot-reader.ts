import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
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

const execFile = promisify(execFileCb)

/**
 * The cheap-tier sibling of the strict evidence reader: same coalescing and TTL, a
 * column set without `tty=`/`command=`. Separate instance because the two column sets
 * parse differently and a cheap capture must never be served to an evidence consumer.
 */
const cheapProcessTableReader = createProcessTableSnapshotReader<CheapProcessTableRow[]>({
  runPs: async () => {
    let stdout: string
    try {
      ;({ stdout } = await execFile('ps', [...CHEAP_PS_ARGS], {
        encoding: 'utf-8',
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_BUFFER_BYTES
      }))
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new ProcessTableCaptureError('capture_truncated')
      }
      throw error
    }
    if (Buffer.byteLength(stdout, 'utf-8') >= PS_MAX_BUFFER_BYTES) {
      throw new ProcessTableCaptureError('capture_truncated')
    }
    return parseCheapProcessTableRows(stdout)
  },
  now: () => Date.now()
})

/** Same wait bound as the evidence read: a stalled cheap capture must fall through to the full
 *  path's own handling rather than pin a polled tick. */
export async function getCheapProcessTableSnapshot(): Promise<CheapProcessTableRow[]> {
  return withEvidenceBudget(cheapProcessTableReader.getSnapshot())
}

export function resetCheapProcessTableSnapshotForTests(): void {
  cheapProcessTableReader.reset()
}
