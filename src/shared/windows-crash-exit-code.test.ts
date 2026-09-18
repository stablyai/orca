import { describe, expect, it } from 'vitest'
import { formatCrashReportExitCode } from './crash-report-exit-code'
import { decodeWindowsCrashExitCode, describeWindowsCrashExitCode } from './windows-crash-exit-code'

describe('decodeWindowsCrashExitCode', () => {
  // The value Electron reported verbatim in crash report 7056ae89 (v1.4.200,
  // win32 10.0.26200), which triage could not name before this table existed.
  it('names the self-terminate Crashpad applies when its handler never answers', () => {
    const decoded = decodeWindowsCrashExitCode(-36863)
    expect(decoded).toEqual({
      code: 0xffff7001,
      description: 'crash handler unreachable; client self-terminated without a minidump'
    })
  })

  // Signed and unsigned spellings of one code must not decode differently. Both
  // rows assert against the literal record: comparing one call to another would
  // still pass if the decoder returned null for everything.
  const spellings: [string, number][] = [
    ['signed', -36863],
    ['unsigned', 0xffff7001]
  ]
  it.each(spellings)('decodes the %s spelling to the same record', (_name, exitCode) => {
    expect(decodeWindowsCrashExitCode(exitCode)).toEqual({
      code: 0xffff7001,
      description: 'crash handler unreachable; client self-terminated without a minidump'
    })
  })

  // Every remaining table row, titled with the hex spelling so a failure names
  // the constant that broke. A typo in one of these would ship a confidently
  // wrong cause, which is the exact failure this table exists to prevent.
  const tableRows: [string, number, string][] = [
    ['0xFFFF7002', 0xffff7002, 'Crashpad handler could not snapshot the process'],
    ['0xFFFF7003', 0xffff7003, 'client never registered with the crash handler'],
    ['0xE0000008', 0xe0000008, 'Chromium app-raised out-of-memory'],
    ['0x80000003', 0x80000003, 'STATUS_BREAKPOINT (CHECK/int3 abort)'],
    ['0xC0000005', 0xc0000005, 'STATUS_ACCESS_VIOLATION'],
    ['0xC0000374', 0xc0000374, 'STATUS_HEAP_CORRUPTION'],
    ['0xC000013A', 0xc000013a, 'STATUS_CONTROL_C_EXIT'],
    ['0x40010004', 0x40010004, 'DBG_TERMINATE_PROCESS']
  ]
  it.each(tableRows)('decodes %s', (_hex, exitCode, description) => {
    expect(decodeWindowsCrashExitCode(exitCode)?.description).toBe(description)
  })

  // 0xFFFF7002 is applied by the HANDLER to the client, unlike 7001/7003 which
  // the client applies to itself. A triager who conflates them clusters a
  // handler-side snapshot failure with a handler-unreachable incident.
  it('distinguishes a handler-side snapshot failure from an unreachable handler', () => {
    expect(decodeWindowsCrashExitCode(0xffff7002)?.description).toContain('handler could not')
    expect(decodeWindowsCrashExitCode(0xffff7001)?.description).toContain('self-terminated')
  })

  // Exit 1 is the whole Windows tree-kill cluster in scan 7. It stays undecoded
  // on purpose: a plain exit(1) is indistinguishable from Task Manager End task.
  const undecoded: [string, number][] = [
    ['1 (exit(1) or Task Manager End task)', 1],
    ['0', 0],
    ['42', 42],
    ['0xDEADBEEF', 0xdeadbeef]
  ]
  it.each(undecoded)('leaves %s undecoded', (_name, exitCode) => {
    expect(decodeWindowsCrashExitCode(exitCode)).toBeNull()
  })

  // `>>> 0` is ToUint32: it truncates and wraps instead of rejecting. Each of
  // these lands on a REAL table key once truncated, so without the guard they
  // would name a confidently wrong Crashpad failure rather than returning null.
  const truncationHazards: [string, number, string][] = [
    ['-36862.5 truncates onto 0xFFFF7002', -36862.5, 'handler could not snapshot'],
    ['-36863.5 truncates onto 0xFFFF7001', -36863.5, 'self-terminated'],
    ['4294930433.5 truncates onto 0xFFFF7001', 4294930433.5, 'self-terminated']
  ]
  it.each(truncationHazards)(
    'rejects %s instead of decoding it',
    (_name, exitCode, wouldDecodeTo) => {
      expect(decodeWindowsCrashExitCode(exitCode)).toBeNull()
      // The hazard is only real while the truncated value is a live key, so pin it.
      expect(decodeWindowsCrashExitCode(Math.trunc(exitCode))?.description).toContain(wouldDecodeTo)
    }
  )

  // Out of 32-bit range at BOTH ends. Each of these wraps onto a real table key
  // under ToUint32, so each one defends a specific half of the range check —
  // a bound is only tested by a value that would decode to something if removed.
  const outOfRange: [string, number][] = [
    ['2**32 + 0xFFFF7001, which wraps to 0xFFFF7001', 2 ** 32 + 0xffff7001],
    ['-(2**32) - 36863, which wraps to 0xFFFF7001', -(2 ** 32) - 36863],
    ['-(2**32) - 36862, which wraps to 0xFFFF7002', -(2 ** 32) - 36862],
    ['-0x80000001, one past the signed floor', -0x80000001]
  ]
  it.each(outOfRange)('rejects %s', (_name, exitCode) => {
    expect(decodeWindowsCrashExitCode(exitCode)).toBeNull()
  })

  it('rejects a non-integer rather than indexing with it', () => {
    expect(decodeWindowsCrashExitCode(1.5)).toBeNull()
    expect(decodeWindowsCrashExitCode(Number.NaN)).toBeNull()
  })

  it('renders the code in the 0x spelling every source documents', () => {
    const decoded = decodeWindowsCrashExitCode(-36863)
    expect(decoded).not.toBeNull()
    expect(decoded && describeWindowsCrashExitCode(decoded)).toBe(
      '0xFFFF7001, crash handler unreachable; client self-terminated without a minidump'
    )
  })
})

describe('formatCrashReportExitCode on win32', () => {
  it('keeps the raw value first and appends the meaning', () => {
    expect(
      formatCrashReportExitCode({ exitCode: -36863, platform: 'win32', reason: 'crashed' })
    ).toBe(
      '-36863 (0xFFFF7001, crash handler unreachable; client self-terminated without a minidump)'
    )
  })

  it('leaves an undecodable Windows code exactly as it was', () => {
    expect(formatCrashReportExitCode({ exitCode: 1, platform: 'win32', reason: 'killed' })).toBe(
      '1'
    )
  })

  // Before this change every win32 code fell through to the raw string. The
  // POSIX decoder was never the risk here (it rejects anything above 0xffff);
  // the guard is that win32 now resolves through its own table.
  it('decodes a Windows code through the Windows table, not the POSIX one', () => {
    const formatted = formatCrashReportExitCode({
      exitCode: 0xe0000008,
      platform: 'win32',
      reason: 'oom'
    })
    expect(formatted).toContain('Chromium app-raised out-of-memory')
  })

  // The launch table decodes small sandbox codes; an NTSTATUS is far outside its range and
  // must never fall back to this table, or a launch that never started would be reported as
  // an access violation. Pinned here as well as in windows-launch-failure-code.test.ts
  // because this is the table that would be borrowed from.
  it('does not decode an NTSTATUS carried by a launch-failed report', () => {
    expect(
      formatCrashReportExitCode({
        exitCode: 0xc0000005,
        platform: 'win32',
        reason: 'launch-failed'
      })
    ).toBe(String(0xc0000005))
  })

  // The POSIX path must be untouched by this change.
  const posixCases: [number, NodeJS.Platform, string, string][] = [
    [9, 'linux', 'crashed', '9 (SIGKILL)'],
    [0, 'darwin', 'crashed', '0']
  ]
  it.each(posixCases)(
    'still decodes %s on %s as before',
    (exitCode, platform, reason, expected) => {
      expect(formatCrashReportExitCode({ exitCode, platform, reason })).toBe(expected)
    }
  )
})
