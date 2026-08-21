import { describe, expect, it } from 'vitest'
import {
  formatCrashReportText,
  formatUncapturedCrashReportText,
  isCrashReportReason,
  sanitizeCrashReportBreadcrumbs,
  sanitizeCrashReportDetails,
  sanitizeCrashReportString,
  type CrashReportRecord
} from './crash-reporting'

describe('crash-reporting shared helpers', () => {
  it('redacts paths and common secret-shaped strings', () => {
    const text =
      'file /Users/alice/My Project/.env /tmp/build log C:\\Users\\bob\\My Project token=abc123 ghp_abcdefghijklmnopqrstuvwxyz'

    expect(sanitizeCrashReportString(text)).toBe(
      'file [redacted-path] [redacted-path] [redacted-path] token=[redacted] [redacted-secret]'
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
        nested: { nope: true },
        infinite: Number.POSITIVE_INFINITY
      })
    ).toEqual({
      name: 'GPU [redacted-path]',
      code: 9,
      crashed: true,
      missing: null,
      error_stack: expect.stringContaining('[redacted-path]')
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
        data: {
          path: '/Users/alice/project',
          ok: true,
          nested: { ignored: true }
        }
      }))
    )

    expect(breadcrumbs).toHaveLength(30)
    expect(breadcrumbs?.[0].name).toBe('event_2')
    expect(breadcrumbs?.[0].data).toEqual({
      path: '[redacted-path]',
      ok: true
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
})
