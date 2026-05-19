import { describe, expect, it } from 'vitest'
import {
  formatCrashReportText,
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
    expect(
      sanitizeCrashReportDetails({
        name: 'GPU /home/alice/repo',
        code: 9,
        crashed: true,
        missing: null,
        nested: { nope: true },
        infinite: Number.POSITIVE_INFINITY
      })
    ).toEqual({
      name: 'GPU [redacted-path]',
      code: 9,
      crashed: true,
      missing: null
    })
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

    const text = formatCrashReportText(report, 'saw /Users/me/project')

    expect(text).toContain('[Crash Report]')
    expect(text).toContain('Recent activity:')
    expect(text).toContain('agent_state_changed')
    expect(text).toContain('User notes:')
    expect(text).toContain('[redacted-path]')
    expect(text).not.toContain('Route:')
    expect(text).not.toContain('URL:')
  })
})
