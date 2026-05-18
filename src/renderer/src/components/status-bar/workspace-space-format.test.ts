import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatCompactCount,
  getWorkspaceSpaceScanTimeLabel,
  getWorkspaceSpaceStatusLabel
} from './workspace-space-format'

describe('workspace space format helpers', () => {
  it('formats byte values with stable units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.50 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB')
  })

  it('formats counts and statuses for dense table UI', () => {
    expect(formatCompactCount(1530)).toBe('1.5k')
    expect(formatCompactCount(25_000)).toBe('25k')
    expect(getWorkspaceSpaceStatusLabel('permission-denied')).toBe('No access')
  })

  it('formats scan times as relative age labels', () => {
    const now = new Date('2026-05-14T22:15:00Z').getTime()
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

    expect(getWorkspaceSpaceScanTimeLabel(now - 2 * 60_000, now)).toBe(
      formatter.format(-2, 'minute')
    )
    expect(getWorkspaceSpaceScanTimeLabel(now - 3 * 60 * 60_000, now)).toBe(
      formatter.format(-3, 'hour')
    )
  })
})
