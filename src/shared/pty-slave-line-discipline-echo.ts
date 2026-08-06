import { execFile, type ExecFileException } from 'node:child_process'

// Why this exists: a startup color reply is written to the PTY master, and a POSIX
// line discipline in ECHO copies it straight back out as visible junk (#12112).
// Whether that will happen is readable state on the slave, not something that has to
// be inferred from the bytes that come back — so Orca asks instead of guessing.

/** `unknown` means "could not be determined", never "assume quiet". */
export type PtySlaveLineDisciplineEcho = 'echoing' | 'quiet' | 'unknown'

export type PtySlaveEchoProbe = () => Promise<PtySlaveLineDisciplineEcho>

const STTY_TIMEOUT_MS = 2_000
// `stty -a` prints the lflags as a space-separated list where a disabled flag is
// prefixed with `-`, so `echo` and `-echo` are the two tokens that matter.
const ECHO_FLAG = /(?:^|\s)(-?)echo(?:\s|$)/

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

type SttyProbeResult = { state: PtySlaveLineDisciplineEcho; permanent: boolean }

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
            ? { state: 'unknown', permanent: isPermanentSttyFailure(error) }
            : { state: parseEchoFlag(stdout), permanent: false }
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
  if (platform === 'win32' || !ptsName) {
    return undefined
  }
  // Why latch: `stty` missing or the slave already reaped is a permanent condition for
  // this pty, and the caller polls — without this a dead probe respawns a process per
  // attempt. A successful probe is never cached, because the bit is what changes, and a
  // transient failure is not latched at all (see isPermanentSttyFailure).
  let unavailable = false
  return async () => {
    if (unavailable) {
      return 'unknown'
    }
    const result = await runStty(ptsName, platform)
    unavailable = result.permanent
    return result.state
  }
}
