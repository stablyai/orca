// Chromium on Windows surfaces the raw process exit code, so a crash report shows
// -36863 where "the crash handler never answered, so the client killed itself and
// wrote no minidump" is meant. Decode for display only — the raw value stays the
// stored source of truth, exactly as posix-wait-status.ts does for waitpid().

export type WindowsCrashExitCodeDecode = {
  /** The exit code normalized to unsigned, which is how every source documents it. */
  code: number
  description: string
}

// Only codes with a single documented meaning for a Chromium/Electron child.
// Deliberately absent: exit 1, which Task Manager's "End task" produces but a
// plain exit(1) does too — labelling it would mislabel ordinary failures.
const WINDOWS_CRASH_EXIT_CODE_DESCRIPTIONS: Record<number, string> = {
  // crashpad/util/win/termination_codes.h. Who applies the code is the whole
  // triage discriminator, so keep these two groups apart.
  // Client to itself, because it could not reach the handler at all:
  0xffff7001: 'crash handler unreachable; client self-terminated without a minidump',
  0xffff7003: 'client never registered with the crash handler',
  // Handler to the client: it DID take the exception, then failed to snapshot,
  // so the real exception code was never recovered.
  0xffff7002: 'Crashpad handler could not snapshot the process',
  // Chromium raises this through RaiseException for an app-detected allocation
  // failure; the customer bit is set, so it is not an NTSTATUS.
  0xe0000008: 'Chromium app-raised out-of-memory',
  0x80000003: 'STATUS_BREAKPOINT (CHECK/int3 abort)',
  0xc0000005: 'STATUS_ACCESS_VIOLATION',
  0xc0000374: 'STATUS_HEAP_CORRUPTION',
  0xc000013a: 'STATUS_CONTROL_C_EXIT',
  0x40010004: 'DBG_TERMINATE_PROCESS'
}

export function decodeWindowsCrashExitCode(exitCode: number): WindowsCrashExitCodeDecode | null {
  // Range-checked like decodePosixWaitStatus, because `>>> 0` below is ToUint32:
  // it truncates and wraps rather than rejecting, so -36862.5 would otherwise
  // land on 0xFFFF7002 and name a different Crashpad failure than the caller had.
  if (!Number.isInteger(exitCode) || exitCode < -0x80000000 || exitCode > 0xffffffff) {
    return null
  }
  // Callers disagree on signedness for the same value (-36863 vs 4294930433), so
  // normalize before the lookup instead of storing both spellings.
  const code = exitCode >>> 0
  const description = WINDOWS_CRASH_EXIT_CODE_DESCRIPTIONS[code]
  return description === undefined ? null : { code, description }
}

export function describeWindowsCrashExitCode(decode: WindowsCrashExitCodeDecode): string {
  // Every current table key is already 8 hex digits; the pad only guards a
  // shorter one being added later.
  return `0x${decode.code.toString(16).toUpperCase().padStart(8, '0')}, ${decode.description}`
}
