import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readPsStdoutBudgeted, readPsStdoutInProcess } from './libproc-process-table'
import { PS_MAX_BUFFER_BYTES, ProcessTableCaptureError } from './process-table-snapshot'
import { psLocaleEnvironment } from './ps-locale-environment'

const execFile = promisify(execFileCb)

// command= costs 1.15s for 1,948 idle processes, 1.3–6s at load 27; 3s failed 6/20 captures.
// Allow 15s for identity reads on busy hosts while bounding wedged ps.
export const PS_TIMEOUT_MS = 15_000

/** Reject captures truncated at the subprocess ceiling or containing no rows. */
export function assertWholeCapture(stdout: string): string {
  if (Buffer.byteLength(stdout, 'utf-8') >= PS_MAX_BUFFER_BYTES) {
    throw new ProcessTableCaptureError('capture_truncated')
  }
  if (!/\S/.test(stdout)) {
    throw new ProcessTableCaptureError('empty_capture')
  }
  return stdout
}

/** One ps-shaped capture: in process where possible; `background` (a display poll) yields the fork budget, and
 * `onArgvReadAt` learns when the oldest recovered argv in it was read. */
export async function captureProcessTable(
  args: readonly string[],
  timeout = PS_TIMEOUT_MS,
  ps = false,
  background = false,
  onArgvReadAt?: (monotonicMs: number) => void
) {
  const env = psLocaleEnvironment()
  const options = { timeoutMs: timeout, maxOutputBytes: PS_MAX_BUFFER_BYTES, background }
  let stdout = ps ? null : await readPsStdoutInProcess(args, { env, ...options, onArgvReadAt })
  try {
    // A forced subprocess capture (held naming pass) shares the fork budget; elsewhere ps is the only reader.
    stdout ??=
      ps && process.platform === 'darwin'
        ? await readPsStdoutBudgeted(args, { env: env ?? process.env, ...options })
        : (
            await execFile('ps', [...args], {
              encoding: 'utf-8',
              env,
              timeout,
              maxBuffer: PS_MAX_BUFFER_BYTES
            })
          ).stdout
  } catch (error) {
    // A ceiling hit is truncation, not absence: name it in the domain vocabulary.
    if ((error as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new ProcessTableCaptureError('capture_truncated')
    }
    throw error
  }
  return assertWholeCapture(stdout)
}
