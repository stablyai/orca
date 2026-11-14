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

  // Why every one of these carries a REAL offset: an earlier revision of this
  // change preserved a stack frame's basename when it ended in .js at a line and
  // column, so that the minified asset name — the only axis a minified React
  // stack can be clustered on — survived redaction. It was withdrawn, because
  // "ends in .js with an offset" is a property no user file is prevented from
  // having, and the shape meant to rescue it ("a bundler content hash") turned
  // out to admit any eight trailing characters that are not all lowercase:
  // YYYYMMDD dates, _v2 suffixes, and every capitalised eight-letter word.
  //
  // These fixtures are the counterexamples that killed it. They must redact
  // whole, and they are kept so that a future attempt to preserve frames has to
  // clear them first.
  it.each([
    ['a dated document', 'at f (/Users/alice/Documents/tax-return-20241231.js:4:9)', 'tax-return'],
    ['a personal journal', 'at f (/home/bob/notes/therapy-journal-20250101.js:1:1)', 'therapy'],
    [
      'a name-bearing document',
      'crash at /Users/alice/Documents/bob-divorce-settlement.js:3:9',
      'divorce'
    ],
    ['an email-shaped stem', 'at f (/opt/x/johnsmith_acme_com-CHo8p2a1.js:1:2)', 'johnsmith'],
    ['a versioned script', 'at f (/Users/alice/work/deploy-final_v2.js:1:2)', 'deploy-final'],
    ['a capitalised word tail', 'at f (/Users/alice/x/notes-Personal.js:2:3)', 'Personal'],
    ['an unhashed entry point', 'at f (/Users/alice/app/index.js:1:2)', 'index.js'],
    [
      'a project setup script',
      'at Object.x (/Users/alice/work/acme-gateway/.orca/setup.js:4:11)',
      'acme-gateway'
    ],
    [
      'a real bundler asset, which is also redacted now',
      'at _i (file:///Users/alice/orca/assets/Terminal-CHo8p2a1.js:1:7269)',
      'Terminal-CHo8p2a1'
    ]
  ])('redacts %s whole', (_case, value, marker) => {
    const sanitized = sanitizeCrashReportString(value, 4_000)

    expect(sanitized).not.toContain('alice')
    expect(sanitized).not.toContain('bob')
    expect(sanitized).not.toContain(marker)
  })

  // Why these are pinned: each is a property review found load-bearing and
  // untested. The `i` flag guards a real leak — an uppercase scheme was
  // redacted by nothing at all before — and it has to be pinned on BOTH rules,
  // so the quoted and unquoted forms are asserted separately. Not crossing a
  // newline is what stops the quoted rule swallowing a whole stack region. And
  // every other `file://` fixture in this file uses a double quote or none, so
  // the single-quote and backtick forms are the untested half of rule 1.
  it.each([
    ['an unquoted uppercase scheme', 'at f (FILE:///Users/alice/secret.log)'],
    ['an unquoted mixed-case scheme', 'at f (File:///home/alice/secret.log)'],
    ['a double-quoted uppercase scheme', 'opened "FILE:///Users/alice/My Docs/a.log" ok'],
    ['a single-quoted file URL', "opened 'file:///Users/alice/My Docs/a.log' ok"],
    ['a backtick-quoted file URL', 'opened `file:///Users/alice/My Docs/a.log` ok'],
    ['a two-slash file URL', 'at f (file://Users/alice/secret.log)'],
    ['a two-slash Windows file URL', 'at f (file://C:/Users/alice/secret.log)'],
    ['a backslash-separated file URL', 'at f (file://\\Users\\alice\\secret.log)'],
    ['a localhost authority', 'at f (file://localhost/Users/alice/secret.log)'],
    ['a host/share authority', 'at f (file://nas.corp.local/finance/alice/pay.xlsx)']
  ])('redacts %s', (_case, value) => {
    expect(sanitizeCrashReportString(value, 4_000)).not.toContain('alice')
  })

  // Why: the unquoted rule takes everything after the scheme, so the literal
  // token in prose must not be swallowed. Nothing follows it there, and the
  // pattern requires at least one character.
  it('leaves the bare file:// token in prose alone', () => {
    const value = 'use the file:// scheme for local paths'

    expect(sanitizeCrashReportString(value, 4_000)).toBe(value)
  })

  it('does not let a quoted file URL swallow the following line', () => {
    const sanitized = sanitizeCrashReportString(
      '"file:///Users/alice/a.log\nkeep this line"',
      4_000
    )

    expect(sanitized).toContain('keep this line')
    expect(sanitized).not.toContain('alice')
  })

  // Why the order matters: these two rules run ahead of the pre-existing quoted
  // and unquoted path rules, and moving them to the end of the list leaves a
  // leaking input behind. The ordering is load-bearing, so it is asserted.
  it('redacts a quoted region whose path is not a file URL', () => {
    expect(sanitizeCrashReportString('"/Users/alice/My Docs/notes.log"', 4_000)).toBe(
      '[redacted-path]'
    )
  })

  // Why per platform: this is the asymmetry the change exists to remove. A
  // POSIX file URL was redacted by nothing at all, and a Windows one by the
  // unquoted-Windows rule; now one rule covers both, and neither ships a path.
  it.each([
    [
      'darwin',
      'at _i (file:///Users/alice/Orca.app/out/renderer/assets/Terminal-CHo8p2a1.js:1:7269)'
    ],
    ['linux', 'at _i (file:///home/alice/.local/share/orca/assets/client-CXJwj0PF.js:8:27510)'],
    ['win32 URL', 'at _i (file:///C:/Users/alice/AppData/orca/assets/Terminal-CHo8p2a1.js:1:7269)'],
    ['win32 backslash', 'at _i (C:\\Users\\alice\\AppData\\orca\\Terminal-CHo8p2a1.js:1:7269)']
  ])('redacts a %s stack frame', (_platform, frame) => {
    expect(sanitizeCrashReportString(frame, 4_000)).toBe('at _i ([redacted-path])')
  })

  it.each([
    [
      // No directory means nothing to preserve a basename against, so this
      // falls through to whole-path redaction rather than being a special case.
      'a file URL with no directory',
      'file:///Terminal-CHo8p2a1.js:1:7269',
      '[redacted-path]'
    ],
    [
      'a quoted URL holding spaces',
      'opened "file:///Users/alice/My Docs/notes.log" ok',
      'opened [redacted-path] ok'
    ],
    [
      'a percent-encoded space',
      'opened file:///Users/alice/My%20Docs/notes.log ok',
      'opened [redacted-path] ok'
    ],
    [
      'a POSIX file URL in prose',
      'file:///home/alice/orca/x.log then recovered.',
      '[redacted-path] then recovered.'
    ],
    [
      'an http URL',
      'see https://react.dev/errors/185 for details',
      'see https://react.dev/errors/185 for details'
    ],
    [
      'a node internal frame',
      'at genericNodeError (node:internal/errors:986:15)',
      'at genericNodeError (node:internal/errors:986:15)'
    ],
    [
      'prose holding a colon',
      'the ratio was 3:4 and file: was empty',
      'the ratio was 3:4 and file: was empty'
    ]
  ])('handles %s', (_case, value, expected) => {
    expect(sanitizeCrashReportString(value, 4_000)).toBe(expected)
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
