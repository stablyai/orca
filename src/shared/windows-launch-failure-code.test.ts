import { describe, expect, it } from 'vitest'
import { formatCrashReportExitCode } from './crash-report-exit-code'
import {
  decodeWindowsLaunchFailureCode,
  describeWindowsLaunchFailureCode
} from './windows-launch-failure-code'

describe('decodeWindowsLaunchFailureCode', () => {
  // The code from crash report a8562106 (v1.4.201, win32 10.0.26100, Electron 43.7.0).
  it('names the code the field report actually carried', () => {
    const decoded = decodeWindowsLaunchFailureCode(18)
    expect(decoded).toEqual({
      code: 18,
      name: 'SBOX_ERROR_CREATE_PROCESS',
      description: 'error in creating process'
    })
    expect(describeWindowsLaunchFailureCode(decoded!)).toBe(
      'SBOX_ERROR_CREATE_PROCESS, error in creating process'
    )
  })

  // Chromium pins these values explicitly and appends new ones, so the table's edges are the
  // contract: 72 is the last sandbox code and 73 (SBOX_ERROR_LAST) is a placeholder, never a
  // real result. A future Chromium adding 73+ must degrade to the raw number, not shift names.
  it.each([
    [11, 'SBOX_ERROR_CANNOT_CREATE_DESKTOP'],
    [31, 'SBOX_ERROR_INITIALIZE_INTERCEPTIONS'],
    [63, 'SBOX_ERROR_CANNOT_LAUNCH_UNSANDBOXED_PROCESS'],
    [68, 'SBOX_ERROR_MISMATCH_SENTINEL_VALUE'],
    [72, 'SBOX_ERROR_DISABLING_APPHELP']
  ])('decodes sandbox code %i as %s', (code, name) => {
    expect(decodeWindowsLaunchFailureCode(code)?.name).toBe(name)
  })

  it('stops at the end of the sandbox range', () => {
    expect(decodeWindowsLaunchFailureCode(73)).toBeNull()
    expect(decodeWindowsLaunchFailureCode(1000)).toBeNull()
  })

  // content/browser/child_process_launcher.h starts at 1001 precisely so it cannot collide
  // with the sandbox range; Chromium static_asserts that on Windows.
  it('decodes the disjoint LaunchResultCode range', () => {
    expect(decodeWindowsLaunchFailureCode(1003)?.name).toBe('LAUNCH_RESULT_FAILURE')
    expect(decodeWindowsLaunchFailureCode(1004)).toBeNull()
  })

  // Naming any of these would report normal behaviour, a sentinel, or a contradiction as a
  // diagnosed fault — the one rule the table's omissions follow.
  it.each([[0], [62], [1001], [1002]])('refuses %i, which would mislead', (code) => {
    expect(decodeWindowsLaunchFailureCode(code)).toBeNull()
  })

  // Mutation-tested, and the result is worth stating exactly: adding `>>> 0` alone changes
  // nothing (the guard rejects these first) and removing the guard alone changes nothing (the
  // object lookup misses on a negative or fractional key). Each is individually a no-op, so no
  // test can catch either on its own. Together they are not a no-op, and that is the realistic
  // regression — whoever adds the coercion sees the guard as redundant and drops it. The last
  // two rows catch exactly that, because ToUint32 maps them onto real keys: 1.5 -> 1
  // (SBOX_ERROR_GENERIC) and -4294967278 -> 18 (CREATE_PROCESS).
  it.each([[-1], [Number.NaN], [1.5], [-4294967278]])(
    'rejects %p rather than coercing it',
    (value) => {
      expect(decodeWindowsLaunchFailureCode(value)).toBeNull()
    }
  )

  // 65 of the table's 71 rows are asserted nowhere individually. The enum is contiguous 0..72 by
  // construction, so this catches a row dropped or renumbered by an edit without restating 71
  // descriptions that would just be the table copied twice.
  it('decodes every sandbox code in the contiguous range except the excluded ones', () => {
    const undecodable = Array.from({ length: 73 }, (_, code) => code).filter(
      (code) => decodeWindowsLaunchFailureCode(code) === null
    )
    expect(undecodable).toEqual([0, 62])
  })

  it('renders the LaunchResultCode branch too', () => {
    expect(describeWindowsLaunchFailureCode(decodeWindowsLaunchFailureCode(1003)!)).toBe(
      'LAUNCH_RESULT_FAILURE, generic launch failure with no sandbox stage recorded'
    )
  })
})

describe('launch-failed dispatch in describeCrashReportExitCode', () => {
  it('decodes a win32 launch failure end to end', () => {
    expect(
      formatCrashReportExitCode({ exitCode: 18, platform: 'win32', reason: 'launch-failed' })
    ).toBe('18 (SBOX_ERROR_CREATE_PROCESS, error in creating process)')
  })

  // The regression a well-meaning refactor would introduce: Chromium can only ever report
  // LAUNCH_RESULT_FAILURE off Windows, so 18 there is not a sandbox stage and naming it
  // would invent a cause. It must render exactly as it did before this change.
  it.each<NodeJS.Platform>(['darwin', 'linux'])('leaves %s launch codes raw', (platform) => {
    expect(formatCrashReportExitCode({ exitCode: 18, platform, reason: 'launch-failed' })).toBe(
      '18'
    )
  })

  // The launch namespace must never fall through to the other two tables.
  it('does not borrow the NTSTATUS table for a launch failure', () => {
    expect(
      formatCrashReportExitCode({
        exitCode: 0xc0000005,
        platform: 'win32',
        reason: 'launch-failed'
      })
    ).toBe(String(0xc0000005))
  })

  // 18 means three different things in three namespaces, which is the whole reason the launch
  // table is separate: a sandbox stage under launch-failed, an unnamed Windows status under
  // crashed, and a POSIX wait status (signalled, not exited) under crashed on Linux.
  it('does not borrow the launch table for a process that actually ran', () => {
    expect(formatCrashReportExitCode({ exitCode: 18, platform: 'win32', reason: 'crashed' })).toBe(
      '18'
    )
    expect(formatCrashReportExitCode({ exitCode: 18, platform: 'linux', reason: 'crashed' })).toBe(
      '18 (signal 18)'
    )
  })
})
