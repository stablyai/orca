import { describe, expect, it } from 'vitest'
import {
  formatCrashReportText,
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
