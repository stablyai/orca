import { execFile, type ExecFileException } from 'node:child_process'

// Why this exists: a startup color reply is written to the PTY master, and a POSIX
// line discipline in ECHO copies it straight back out as visible junk (#12112).
// Whether that will happen is readable state on the slave, not something that has to
// be inferred from the bytes that come back — so Orca asks instead of guessing.

/** `unknown` means "could not be determined", never "assume quiet". */
export type PtySlaveLineDisciplineEcho = 'echoing' | 'quiet' | 'unknown'

export type PtySlaveEchoProbe = () => Promise<PtySlaveLineDisciplineEcho>

export type PtySlaveLineEditorState = 'line-editor' | 'other' | 'unknown'

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

function parseEchoFlag(sttyOutput: string): PtySlaveLineDisciplineEcho {
  const match = ECHO_FLAG.exec(sttyOutput)
  if (!match) {
    return 'unknown'
  }
  return match[1] === '-' ? 'quiet' : 'echoing'
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

/**
 * A spawn that never ran (`stty` absent) or a device that answered non-zero (reaped,
 * not a tty) will answer the same way forever. A kill by the timeout, or a fork that
 * failed for want of a resource, is contention — the very thing a multi-pane restore
 * produces — and must not condemn the pty to guessing for the rest of its life.
 */
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

/**
 * node-pty's UnixTerminal carries the slave device path, but its public typings do not
 * declare it and the Windows terminal has no such field — so read it defensively.
 */
export function readPtySlavePath(pty: unknown): string | undefined {
  const candidate = (pty as { ptsName?: unknown } | null | undefined)?.ptsName
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

/**
 * Probe for whether the slave would echo a write to the master right now.
 *
 * Returns undefined when the platform has no line discipline to read: ConPTY and
 * wsl.exe do not echo a master write at all, so a caller with no probe is correct to
 * write immediately rather than degraded. A probe that exists but answers `unknown`
 * is the degraded case, and callers must not read that as `quiet`.
 */
export function createPtySlaveEchoProbe(
  ptsName: string | undefined,
  platform: NodeJS.Platform = process.platform
): PtySlaveEchoProbe | undefined {
  return createSttyProbe(ptsName, platform, parseEchoFlag)
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
): (() => Promise<T | 'unknown'>) | undefined {
  if (platform === 'win32' || !ptsName) {
    return undefined
  }
  // Why latch: `stty` missing or the slave already reaped is a permanent condition for
  // this pty, and the caller polls — without this a dead probe respawns a process per
  // attempt. A successful probe is never cached, because the bit is what changes, and a
  // transient failure is not latched at all (see isPermanentSttyFailure).
  let unavailable = false
  let inFlight: Promise<SttyProbeResult> | null = null
  return async () => {
    if (unavailable) {
      return 'unknown'
    }
    inFlight ??= runStty(ptsName, platform).finally(() => {
      inFlight = null
    })
    const result = await inFlight
    unavailable = result.permanent
    return result.stdout === null ? 'unknown' : parse(result.stdout)
  }
}
