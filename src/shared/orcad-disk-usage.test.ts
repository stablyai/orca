import { describe, expect, it } from 'vitest'
import {
  lowDiskLevelForVolume,
  OrcadDiskUsageResultSchema,
  worstLowDiskVolume,
  type OrcadDiskVolumeUsage
} from './orcad-disk-usage'

const MIB = 1024 ** 2
const GIB = 1024 ** 3

function volume(path: string, totalBytes: number, availableBytes: number): OrcadDiskVolumeUsage {
  return { path, totalBytes, freeBytes: availableBytes, availableBytes, usedPercent: 0 }
}

describe('lowDiskLevelForVolume', () => {
  it.each([
    ['plenty on a 32 GiB disk', 32 * GIB, 10 * GIB, 'ok'],
    ['just above 10% of 32 GiB', 32 * GIB, 3.3 * GIB, 'ok'],
    ['under 10% of 32 GiB', 32 * GIB, 3.1 * GIB, 'warning'],
    ['under 2 GiB on a huge disk', 1024 * GIB, 1.9 * GIB, 'warning'],
    ['10% of a huge disk but above 2 GiB', 1024 * GIB, 100 * GIB, 'warning'],
    ['exactly 500 MiB', 32 * GIB, 500 * MIB, 'warning'],
    ['under 500 MiB', 32 * GIB, 499 * MIB, 'critical'],
    ['full', 32 * GIB, 0, 'critical'],
    ['a zero-size filesystem', 0, 0, 'ok']
  ] as const)('%s', (_label, total, available, expected) => {
    expect(lowDiskLevelForVolume({ totalBytes: total, availableBytes: available })).toBe(expected)
  })

  it('treats a small disk above 2 GiB and 10% as ok', () => {
    expect(lowDiskLevelForVolume({ totalBytes: 8 * GIB, availableBytes: 2.5 * GIB })).toBe('ok')
  })
})

describe('worstLowDiskVolume', () => {
  it('returns null when every volume is fine', () => {
    expect(worstLowDiskVolume([volume('/', 32 * GIB, 20 * GIB)])).toBeNull()
    expect(worstLowDiskVolume([])).toBeNull()
  })

  it('prefers critical over warning, then the least available', () => {
    const warning = volume('/home', 32 * GIB, 1.5 * GIB)
    const warningLower = volume('/data', 32 * GIB, 1 * GIB)
    const critical = volume('/vercel/sandbox', 32 * GIB, 100 * MIB)
    expect(worstLowDiskVolume([warning, critical, warningLower])).toEqual({
      level: 'critical',
      volume: critical
    })
    expect(worstLowDiskVolume([warning, warningLower])).toEqual({
      level: 'warning',
      volume: warningLower
    })
  })
})

describe('OrcadDiskUsageResultSchema', () => {
  it('rejects a malformed reply instead of rendering garbage', () => {
    expect(OrcadDiskUsageResultSchema.safeParse({ volumes: [{ path: '/' }] }).success).toBe(false)
    expect(
      OrcadDiskUsageResultSchema.safeParse({
        checkedAt: 1,
        volumes: [volume('/', 1, 1)]
      }).success
    ).toBe(true)
  })
})
