import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import {
  archiveDialogKeptLine,
  archivedCountdownShort,
  archivedSnapshotLine,
  archiveSnapshotDefinition,
  asleepCountdownShort
} from './archive-snapshot-copy'
import { cloudStateDetail } from './cloud-state-copy'

const NOW = Date.UTC(2026, 10, 11, 12)
const DAY = 86_400_000

describe('asleep countdown: idle retention in the archived countdown’s words', () => {
  it('counts whole days up, then says today', () => {
    expect(asleepCountdownShort(translate, NOW + 3 * DAY - 60_000, NOW)).toBe('deletes in 3 days')
    expect(asleepCountdownShort(translate, NOW + DAY, NOW)).toBe('deletes in 1 day')
    expect(asleepCountdownShort(translate, NOW - 1, NOW)).toBe('deletes today')
  })
})

describe('archive copy: relative retention, never an unexplained date', () => {
  it('the Archive tooltip is one short sentence with the control plane’s TTL', () => {
    const text = archiveSnapshotDefinition(translate, { ttlDays: 14 })
    expect(text).toBe('Stops the workspace and keeps it for 14 days, then deletes it.')
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(12)
  })

  it('before the TTL loads it says 30 days, the control plane default', () => {
    expect(archiveSnapshotDefinition(translate, { ttlDays: null })).toBe(
      'Stops the workspace and keeps it for 30 days, then deletes it.'
    )
    expect(archiveDialogKeptLine(translate, null)).toBe(
      'It’s kept for 30 days, then deleted. You can unarchive it until then.'
    )
  })

  it('an archived workspace counts down in days, in the same words on every surface', () => {
    const keptUntil = NOW + 3 * DAY - 60_000
    const line = archivedSnapshotLine(translate, keptUntil, NOW)
    expect(line).toBe('Read-only. Deletes in 3 days unless you unarchive it.')
    expect(archivedSnapshotLine(translate, NOW + DAY, NOW)).toBe(
      'Read-only. Deletes in 1 day unless you unarchive it.'
    )
    expect(archivedSnapshotLine(translate, NOW - 1, NOW)).toBe(
      'Read-only. Deletes today unless you unarchive it.'
    )
    expect(archivedCountdownShort(translate, keptUntil, NOW)).toBe('deletes in 3 days')
    expect(line).not.toMatch(/snapshot|sandbox hours/)
  })

  it('without a deletion date (older control plane) it names the rule, never a date', () => {
    expect(cloudStateDetail('archived', translate)).toBe(
      'Read-only. Deletes 30 days after archiving unless you unarchive it.'
    )
  })
})
