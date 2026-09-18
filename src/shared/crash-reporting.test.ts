import { describe, expect, it } from 'vitest'
import {
  formatCrashReportText,
  formatUncapturedCrashReportText,
  isCrashReportReason,
  MAX_USER_NOTES_LENGTH,
  sanitizeCrashReportBreadcrumbs,
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

  it('preserves the failing CHECK at the end of a long fatal line', () => {
    const fatalLine = `[FATAL:node.cc(123)] ${'context '.repeat(80)}Check failed: !is_detached_.`

    const sanitized = String(
      sanitizeCrashReportDetails({ minidumpCheckMessage: fatalLine }).minidumpCheckMessage
    )

    expect(sanitized.length).toBeGreaterThan(240)
    expect(sanitized).toContain('Check failed: !is_detached_.')
  })

  it('sanitizes breadcrumb data and caps to the latest thirty entries', () => {
    const breadcrumbs = sanitizeCrashReportBreadcrumbs(
      Array.from({ length: 32 }, (_, index) => ({
        createdAt: `2026-05-16T01:${String(index).padStart(2, '0')}:00.000Z`,
        name: `event_${index}`,
        origin: 'renderer:42',
        data: {
          path: '/Users/alice/project',
          ok: true,
          nested: { ignored: true }
        }
      }))
    )

    expect(breadcrumbs).toHaveLength(30)
    expect(breadcrumbs?.[0].name).toBe('event_2')
    expect(breadcrumbs?.[0]).toMatchObject({
      origin: 'renderer:42',
      data: {
        path: '[redacted-path]',
        ok: true
      }
    })
  })

  it('recognizes crash reasons captured by Electron process-gone events', () => {
    expect(isCrashReportReason('abnormal-exit')).toBe(true)
    expect(isCrashReportReason('crashed')).toBe(true)
    expect(isCrashReportReason('launch-failed')).toBe(true)
    expect(isCrashReportReason('memory-eviction')).toBe(true)
    expect(isCrashReportReason('clean-exit')).toBe(false)
  })

  it('formats reports without route or URL fields', () => {
    const report: CrashReportRecord = {
      id: 'crash-1',
      createdAt: '2026-05-16T01:00:00.000Z',
      status: 'pending',
      source: 'renderer',
      processType: 'renderer',
      reason: 'crashed',
      exitCode: 5,
      appVersion: '1.0.0',
      platform: 'darwin',
      osRelease: '25.0.0',
      arch: 'arm64',
      electronVersion: '41.0.0',
      chromeVersion: '141.0.0',
      details: { reason: 'native crash' },
      breadcrumbs: [
        {
          createdAt: '2026-05-16T00:59:30.000Z',
          name: 'agent_state_changed',
          data: { agentType: 'codex', state: 'working' }
        }
      ]
    }

    const text = formatCrashReportText(report, 'saw /Users/me/project', {
      status: 'uploaded',
      ticketId: 'ticketabcdefghijklmnop',
      bundleSubmissionId: 'bundleabcdefghijklmnop',
      bytes: 1024,
      spanCount: 12
    })

    expect(text).toContain('[Crash Report]')
    expect(text).toContain('Recent activity:')
    expect(text).toContain('agent_state_changed')
    expect(text).toContain('Diagnostic log:')
    expect(text).toContain('ticketabcdefghijklmnop')
    expect(text.indexOf('Diagnostic log:')).toBeLessThan(text.indexOf('Details:'))
    expect(text).toContain('User notes:')
    expect(text).toContain('[redacted-path]')
    expect(text).not.toContain('Route:')
    expect(text).not.toContain('\nURL:')
  })

  it('names the failing CHECK above the details block', () => {
    const fatalLine =
      '[8104:1234:0815/143022.123456:FATAL:render_frame_impl.cc(4821)] Check failed: !is_detached_.'
    const report: CrashReportRecord = {
      id: 'crash-check',
      createdAt: '2026-08-15T01:00:00.000Z',
      status: 'pending',
      source: 'renderer',
      processType: 'renderer',
      reason: 'crashed',
      // The bare STATUS_BREAKPOINT this ticket is about.
      exitCode: -2147483645,
      appVersion: '1.4.183',
      platform: 'win32',
      osRelease: '10.0.19045',
      arch: 'x64',
      electronVersion: '43.1.0',
      chromeVersion: '150.0.7871.47',
      details: {
        minidumpCheckMessage: fatalLine,
        minidumpFaultingModule: 'chrome_elf.dll',
        minidumpFaultingModuleOffset: '0x1234'
      },
      breadcrumbs: []
    }

    const text = formatCrashReportText(report)

    // Why: Chromium logs the source basename, not a path, so the fatal line has
    // to survive path redaction intact or the check is unnameable again.
    expect(text).toContain(`Check failure: ${fatalLine}`)
    expect(text).toContain('Faulting module: chrome_elf.dll+0x1234')
    expect(text.indexOf('Check failure:')).toBeLessThan(text.indexOf('Details:'))
  })

  it('decodes POSIX wait statuses in the exit code line and leaves Windows codes raw', () => {
    const report = (overrides: Partial<CrashReportRecord>): CrashReportRecord => ({
      id: 'crash-wait-status',
      createdAt: '2026-08-14T09:32:19.696Z',
      status: 'pending',
      source: 'renderer',
      processType: 'renderer',
      reason: 'killed',
      exitCode: null,
      appVersion: '1.4.182',
      platform: 'linux',
      osRelease: '7.0.0-28-generic',
      arch: 'x64',
      electronVersion: '43.1.0',
      chromeVersion: '150.0.7871.47',
      details: {},
      ...overrides
    })

    // Field bundles: linux 61696 = exit(241), 9 = SIGKILL, 133 = SIGTRAP+core, darwin 5 = SIGTRAP.
    expect(formatCrashReportText(report({ exitCode: 61696 }))).toContain(
      'Exit code: 61696 (exit status 241)'
    )
    expect(formatCrashReportText(report({ exitCode: 9 }))).toContain('Exit code: 9 (SIGKILL)')
    expect(formatCrashReportText(report({ reason: 'crashed', exitCode: 133 }))).toContain(
      'Exit code: 133 (SIGTRAP, core dumped)'
    )
    expect(
      formatCrashReportText(report({ platform: 'darwin', reason: 'crashed', exitCode: 5 }))
    ).toContain('Exit code: 5 (SIGTRAP)')
    // Windows codes are not wait statuses; they must render byte-identical to before.
    expect(formatCrashReportText(report({ platform: 'win32', exitCode: 1 }))).toContain(
      'Exit code: 1\n'
    )
    expect(
      formatCrashReportText(report({ platform: 'win32', reason: 'oom', exitCode: -536870904 }))
    ).toContain('Exit code: -536870904\n')
    // launch-failed carries a Chromium launch error, not a wait status — never decode it.
    expect(formatCrashReportText(report({ reason: 'launch-failed', exitCode: 18 }))).toContain(
      'Exit code: 18\n'
    )
    // A clean exit(0) must not grow an "(exit status 0)" suffix.
    expect(formatCrashReportText(report({ reason: 'crashed', exitCode: 0 }))).toContain(
      'Exit code: 0\n'
    )
    expect(formatCrashReportText(report({}))).toContain('Exit code: unknown')
  })

  it('caps formatted reports to the crash endpoint limit', () => {
    const report: CrashReportRecord = {
      id: 'crash-oversized',
      createdAt: '2026-05-16T01:00:00.000Z',
      status: 'pending',
      source: 'renderer',
      processType: 'renderer',
      reason: 'crashed',
      exitCode: 5,
      appVersion: '1.0.0',
      platform: 'darwin',
      osRelease: '25.0.0',
      arch: 'arm64',
      electronVersion: '41.0.0',
      chromeVersion: '141.0.0',
      details: Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [`detail_${index}`, 'x'.repeat(240)])
      ),
      breadcrumbs: []
    }

    const text = formatCrashReportText(report)

    expect(text.length).toBeLessThanOrEqual(64_000)
    expect(text).toContain('[Crash report truncated to fit feedback endpoint limits.]')
  })

  it('formats uncaptured crash reports so users can still submit from Help', () => {
    const text = formatUncapturedCrashReportText(
      {
        createdAt: '2026-05-16T01:00:00.000Z',
        appVersion: '1.0.0',
        platform: 'darwin',
        osRelease: '25.0.0',
        arch: 'arm64',
        electronVersion: '41.0.0',
        chromeVersion: '141.0.0'
      },
      'happened after opening /Users/me/project',
      {
        status: 'not_uploaded',
        reason: 'diagnostic upload endpoint is not configured for this build',
        bundleSubmissionId: 'bundleabcdefghijklmnop',
        bytes: 2048,
        spanCount: 3
      }
    )

    expect(text).toContain('Report ID: not captured')
    expect(text).toContain('Reason: no captured crash report')
    expect(text).toContain('Diagnostic log:')
    expect(text).toContain('Status: not uploaded')
    expect(text).toContain('[redacted-path]')
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

  it('bounds an oversized user note to the advertised limit', () => {
    const text = formatCrashReportText(notesReport(), 'z'.repeat(40_000))
    const expected = `${'z'.repeat(MAX_USER_NOTES_LENGTH - 3)}...`

    expect(text).toContain(expected)
    expect(text).not.toContain('z'.repeat(MAX_USER_NOTES_LENGTH - 2))
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

  it('redacts path tokens without deleting surrounding prose', () => {
    const note = [
      'On 8/16/2026 the app froze right after I opened a worktree.',
      'Steps: open View/Layout then Window/Zoom and it crashes on run 3/4.',
      'The log is at /opt/orca/logs/app.log and the repo is /Users/alice/x but this survives.'
    ].join(' ')

    const text = formatCrashReportText(notesReport(), note)

    expect(text).toContain('On 8/16/2026 the app froze')
    expect(text).toContain('open View/Layout then Window/Zoom and it crashes on run 3/4.')
    expect(text).toContain(
      'The log is at [redacted-path] and the repo is [redacted-path] but this survives.'
    )
    expect(text).not.toContain('/opt/orca/logs/app.log')
    expect(text).not.toContain('alice')
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

  it('bounds sanitizer work on a padded paste instead of freezing the dialog', () => {
    // The raw-input clamp prevents path regexes from scanning an unbounded paste.
    const note = `/Users/a${' '.repeat(200_000)}end`
    const startedAt = Date.now()

    const text = formatCrashReportText(notesReport(), note)

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(text.length).toBeLessThan(64_000)
  })

  it('clamps raw notes before trimming', () => {
    const text = formatCrashReportText(
      notesReport(),
      `${' '.repeat(20_000)}content beyond the raw-input limit`
    )

    expect(text).not.toContain('content beyond the raw-input limit')
    expect(text).not.toContain('User notes:')
  })

  it('places Help-menu notes before machine-generated fields', () => {
    const text = formatUncapturedCrashReportText(
      {
        createdAt: '2026-05-16T01:00:00.000Z',
        appVersion: '1.0.0',
        platform: 'darwin',
        osRelease: '25.0.0',
        arch: 'arm64',
        electronVersion: '41.0.0',
        chromeVersion: '141.0.0'
      },
      'the terminal font looks wrong'
    )

    expect(text.startsWith('[Crash Report]')).toBe(true)
    expect(text).toContain('- captured_crash_report: false')
    expect(text).toContain('--- begin user notes ---\n  the terminal font looks wrong')
    expect(text.indexOf('--- begin user notes ---')).toBeLessThan(text.indexOf('Details:'))
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
