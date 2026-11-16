// Decode Chromium’s raw POSIX waitpid status for display (61696 → exit 241); preserve the stored raw value.

export type PosixWaitStatusDecode =
  | { kind: 'exited'; exitStatus: number }
  | { kind: 'signaled'; signal: number; signalName: string | null; coreDumped: boolean }

// Only numbers that are identical on Linux and macOS; naming a divergent one
// (e.g. 7 = SIGBUS on Linux but SIGEMT on macOS) would mislabel real crashes.
const POSIX_INVARIANT_SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  5: 'SIGTRAP',
  6: 'SIGABRT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM'
}

const WAIT_STATUS_SIGNAL_MASK = 0x7f
const WAIT_STATUS_CORE_DUMP_FLAG = 0x80
const WAIT_STATUS_STOPPED_MARKER = 0x7f

export function decodePosixWaitStatus(status: number): PosixWaitStatusDecode | null {
  if (!Number.isInteger(status) || status < 0 || status > 0xffff) {
    return null
  }
  const signal = status & WAIT_STATUS_SIGNAL_MASK
  if (signal === WAIT_STATUS_STOPPED_MARKER) {
    // WIFSTOPPED/WIFCONTINUED shapes never describe a dead process.
    return null
  }
  if (signal === 0) {
    return { kind: 'exited', exitStatus: (status >> 8) & 0xff }
  }
  return {
    kind: 'signaled',
    signal,
    signalName: POSIX_INVARIANT_SIGNAL_NAMES[signal] ?? null,
    coreDumped: (status & WAIT_STATUS_CORE_DUMP_FLAG) !== 0
  }
}

/** Human phrasing for a decoded status: "exit status 241", "SIGKILL", "SIGTRAP, core dumped", "signal 7". */
export function describePosixWaitStatus(decoded: PosixWaitStatusDecode): string {
  if (decoded.kind === 'exited') {
    return `exit status ${decoded.exitStatus}`
  }
  const name = decoded.signalName ?? `signal ${decoded.signal}`
  return decoded.coreDumped ? `${name}, core dumped` : name
}
