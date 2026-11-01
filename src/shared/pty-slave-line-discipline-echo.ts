import { execFile, type ExecFileException } from 'node:child_process'

// Probe line discipline for prompt readiness only. Never defer replies awaiting ECHO-clear: asynchronous writes reordered
// replies into later programs’ stdin (#15559). Suppress echoes on output via pty-startup-reply-echo-shapes.ts.

/** `unknown` means "could not be determined", never "assume quiet". */
export type PtySlaveLineDisciplineEcho = 'echoing' | 'quiet' | 'unknown'

export type PtySlaveLineEditorState = 'line-editor' | 'other' | 'unknown' | 'unavailable'

export type PtySlaveLineEditorProbe = () => Promise<PtySlaveLineEditorState>

const STTY_TIMEOUT_MS = 2_000
// `stty -a` prints the lflags as a space-separated list where a disabled flag is
// prefixed with `-`, so `echo` and `-echo` are the two tokens that matter.
const ECHO_FLAG = /(?:^|\s)(-?)echo(?:\s|$)/
const ICANON_FLAG = /(?:^|\s)(-?)icanon(?:\s|$)/
const LNEXT_UNDEFINED = /(?:^|[;\s])lnext\s*=\s*<undef>(?:;|\s|$)/

function sttyArgs(ptsName: string, platform: NodeJS.Platform): readonly string[] {
  // BSD/macOS take `-f`; Linux (GNU coreutils) takes `-F`.
  return platform === 'darwin' || platform.includes('bsd')
    ? ['-a', '-f', ptsName]
    : ['-a', '-F', ptsName]
}

function parseLineEditorState(sttyOutput: string): PtySlaveLineEditorState {
  const echo = ECHO_FLAG.exec(sttyOutput)
  const icanon = ICANON_FLAG.exec(sttyOutput)
  if (!echo || !icanon) {
    return 'unknown'
  }
  return echo[1] === '-' && icanon[1] === '-' && LNEXT_UNDEFINED.test(sttyOutput)
    ? 'line-editor'
    : 'other'
}

type SttyProbeResult = { stdout: string | null; permanent: boolean }

/** Missing stty/reaped/non-TTY devices fail permanently; timeout/resource contention during restore must remain retryable. */
function isPermanentSttyFailure(error: ExecFileException): boolean {
  if (error.killed || error.signal) {
    return false
  }
  return error.code !== 'EAGAIN' && error.code !== 'EMFILE' && error.code !== 'ENFILE'
}

function runStty(ptsName: string, platform: NodeJS.Platform): Promise<SttyProbeResult> {
  return new Promise((resolve) => {
    execFile(
      'stty',
      sttyArgs(ptsName, platform),
      { timeout: STTY_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        resolve(
          error
            ? { stdout: null, permanent: isPermanentSttyFailure(error) }
            : { stdout, permanent: false }
        )
      }
    )
  })
}

/** node-pty exposes Unix ptsName outside public typings; Windows omits it, so read defensively. */
export function readPtySlavePath(pty: unknown): string | undefined {
  const candidate = (pty as { ptsName?: unknown } | null | undefined)?.ptsName
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

export function createPtySlaveLineEditorProbe(
  ptsName: string | undefined,
  platform: NodeJS.Platform = process.platform
): PtySlaveLineEditorProbe | undefined {
  return createSttyProbe(ptsName, platform, parseLineEditorState)
}

function createSttyProbe<T extends string>(
  ptsName: string | undefined,
  platform: NodeJS.Platform,
  parse: (output: string) => T | 'unknown'
): (() => Promise<T | 'unknown' | 'unavailable'>) | undefined {
  if (platform === 'win32' || !ptsName) {
    return undefined
  }
  // Latch only permanent missing/reaped failures to avoid repeated dead subprocesses. Success and resource contention
  // must be re-probed because line discipline changes.
  let unavailable = false
  let inFlight: Promise<SttyProbeResult> | null = null
  return async () => {
    if (unavailable) {
      return 'unavailable'
    }
    inFlight ??= runStty(ptsName, platform).finally(() => {
      inFlight = null
    })
    const result = await inFlight
    unavailable = result.permanent
    return result.stdout === null
      ? result.permanent
        ? 'unavailable'
        : 'unknown'
      : parse(result.stdout)
  }
}
