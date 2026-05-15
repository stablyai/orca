import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatCompactCount,
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
})
