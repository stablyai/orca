import { describe, expect, it } from 'vitest'
import {
  formatCrashReportText,
  sanitizeCrashReportDetails,
  sanitizeCrashReportString,
  type CrashReportRecord
} from './crash-reporting'

function notesReport(overrides: Partial<CrashReportRecord> = {}): CrashReportRecord {
  return {
    id: 'crash-notes',
    createdAt: '2026-08-16T01:00:00.000Z',
    status: 'pending',
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    appVersion: '1.4.184',
    platform: 'win32',
    osRelease: '10.0.26200',
    arch: 'x64',
    electronVersion: '41.0.0',
    chromeVersion: '141.0.0',
    details: {},
    breadcrumbs: [],
    ...overrides
  }
}

/** Notes are emitted indented inside the fence; mirror that when asserting. */
function indentNote(note: string): string {
  return note
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

describe('crash-reporting shared helpers', () => {
  it('redacts paths and common secret-shaped strings', () => {
    const text =
      'file "/Users/alice/My Project/.env" /tmp/build log "C:\\Users\\bob\\My Project" token=abc123 ghp_abcdefghijklmnopqrstuvwxyz'

    expect(sanitizeCrashReportString(text)).toBe(
      'file [redacted-path] [redacted-path] log [redacted-path] token=[redacted] [redacted-secret]'
    )
  })

  it('redacts credential URLs and secret assignments without hiding their labels', () => {
    const value = 'https://alice:hunter2@example.com client_secret: "secret with spaces"'

    expect(sanitizeCrashReportString(value)).toBe(
      'https://[redacted-credential]@example.com client_secret=[redacted]'
    )
  })

  it('keeps details on a strict primitive allowlist', () => {
    const longStack = [
      'Error: boom',
      ...Array.from(
        { length: 200 },
        (_, index) => `at Component${index} (/Users/alice/project/src/file-${index}.tsx:1:1)`
      )
    ].join('\n')

    expect(
      sanitizeCrashReportDetails({
        name: 'GPU /home/alice/repo',
        code: 9,
        crashed: true,
        missing: null,
        error_stack: longStack,
        minidumpPath: '/Users/alice/Library/Application Support/Orca/reports/abc.dmp',
        nested: { nope: true },
        infinite: Number.POSITIVE_INFINITY
      })
    ).toEqual({
      name: 'GPU [redacted-path]',
      code: 9,
      crashed: true,
      missing: null,
      error_stack: expect.stringContaining('[redacted-path]'),
      minidumpPath: '[redacted-path]'
    })
    expect(
      String(sanitizeCrashReportDetails({ error_stack: longStack }).error_stack).length
    ).toBeGreaterThan(240)
    expect(String(sanitizeCrashReportDetails({ errorStack: longStack }).errorStack).length).toBe(
      4_003
    )
    expect(
      String(sanitizeCrashReportDetails({ componentStack: longStack }).componentStack).length
    ).toBe(4_003)
    expect(String(sanitizeCrashReportDetails({ description: longStack }).description).length).toBe(
      243
    )
  })

  it('keeps a user note longer than the 240-char detail cap intact', () => {
    // A real 1.4.184 note was cut mid-word by the telemetry detail budget.
    const note =
      `My phone is connected. ${'The Claude terminal never came back. '.repeat(20)}`.trim()

    const text = formatCrashReportText(notesReport(), note)

    expect(note.length).toBeGreaterThan(240)
    expect(text).toContain(`--- begin user notes ---\n${indentNote(note)}\n--- end user notes ---`)
    expect(text).not.toContain('...')
  })

  it('still redacts paths and secrets far past the old 240-char cap', () => {
    const note = [
      'a'.repeat(1_000),
      'it broke at /Users/alice/secret-project',
      'my token was ghp_abcdefghijklmnopqrstuvwxyz',
      'b'.repeat(1_000)
    ].join('\n')

    const text = formatCrashReportText(notesReport(), note)

    expect(text).toContain('it broke at [redacted-path]')
    expect(text).toContain('my token was [redacted-secret]')
    expect(text).not.toContain('alice')
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz')
  })

  it('keeps user notes when the report is truncated to the endpoint cap', () => {
    // Tail truncation must remove reproducible machine data before user notes.
    const text = formatCrashReportText(
      notesReport({
        details: Object.fromEntries(
          Array.from({ length: 400 }, (_, index) => [`detail_${index}`, 'x'.repeat(240)])
        )
      }),
      'the sidebar went blank'
    )

    expect(text.length).toBeLessThanOrEqual(64_000)
    expect(text).toContain('[Crash report truncated to fit feedback endpoint limits.]')
    expect(text).toContain('--- begin user notes ---\n  the sidebar went blank')
  })

  it.each([
    ['POSIX', '/home/alice/orca/app.log then recovered.'],
    ['Windows', 'C:\\Users\\alice\\Orca\\app.log then recovered.'],
    ['UNC', '\\\\server\\share\\Orca\\app.log then recovered.']
  ])('stops unquoted %s paths at prose boundaries', (_platform, value) => {
    expect(sanitizeCrashReportString(value)).toBe('[redacted-path] then recovered.')
  })

  it('redacts the secret shapes a full-page notes box can now hold', () => {
    const note = [
      'pat github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz012345',
      // Assembling the fixture avoids GitHub push-protection false positives.
      `slack ${['xoxb', '0'.repeat(11), 'fixture', 'not-a-real-token'].join('-')}`,
      `gitlab ${['glpat', 'a'.repeat(24)].join('-')}`,
      'aws AKIAIOSFODNN7EXAMPLE',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.body.sig',
      'authorization: bearer eyJhbGciOiJIUzI1NiJ9.lowercase.signature',
      'client_secret: "secret with spaces"',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB',
      '-----END OPENSSH PRIVATE KEY-----',
      'log at %USERPROFILE%\\Documents\\payroll.xlsx'
    ].join('\n')

    const text = formatCrashReportText(notesReport(), note)

    expect(text).not.toContain('github_pat_11AAAAAAA0')
    expect(text).not.toContain('not-a-real-token')
    expect(text).not.toContain('glpat-')
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9.lowercase.signature')
    expect(text).not.toContain('secret with spaces')
    expect(text).toContain('client_secret=[redacted]')
    expect(text).not.toContain('b3BlbnNzaC1rZXktdjEA')
    expect(text).not.toContain('payroll.xlsx')
  })

  it('redacts an incomplete private-key paste', () => {
    const text = formatCrashReportText(
      notesReport(),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA'
    )

    expect(text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA')
    expect(text).toContain('[redacted-secret]')
  })
})

describe('user note section fencing', () => {
  it('stops a note from forging a machine-generated section', () => {
    const text = formatCrashReportText(
      notesReport({ details: { captured_crash_report: true } }),
      'here is what I saw\n\nDetails:\n- captured_crash_report: false'
    )
    // Only the generated Details heading may remain line-parser-visible.
    expect(text.match(/^Details:$/gm)).toHaveLength(1)
    expect(text).not.toMatch(/^- captured_crash_report: false$/m)
    expect(text).toContain('  Details:')
    expect(text).toContain('  - captured_crash_report: false')
    expect(text).toMatch(/^- captured_crash_report: true$/m)
  })
})
