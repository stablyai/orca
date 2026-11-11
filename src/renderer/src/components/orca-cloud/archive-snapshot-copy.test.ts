import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { formatShortDate } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { archivedSnapshotLine, archiveSnapshotDefinition } from './archive-snapshot-copy'
import { cloudStateDetail } from './cloud-state-copy'

const NOW = Date.UTC(2026, 10, 11, 12)
const DAY = 86_400_000

describe('archiveSnapshotDefinition (one definition of "snapshot")', () => {
  it('names an archived workspace’s own kept-until date', () => {
    const keptUntil = NOW + 9 * DAY
    const text = archiveSnapshotDefinition(translate, { keptUntil, ttlDays: 30, now: NOW })
    expect(text).toContain(`until ${formatShortDate(keptUntil)}, then deletes it`)
    expect(text).toContain('its files, chats and terminal history')
    expect(text).toContain('Like a sleeping workspace, it doesn’t use sandbox hours.')
  })

  it('before archiving: today plus the control plane’s TTL, so a deployed override shows', () => {
    const text = archiveSnapshotDefinition(translate, { ttlDays: 14, now: NOW })
    expect(text).toContain(`until ${formatShortDate(NOW + 14 * DAY)}`)
  })

  it('without a date or TTL it says "for 30 days" and never invents a date', () => {
    const text = archiveSnapshotDefinition(translate, { ttlDays: null, now: NOW })
    expect(text).toContain('for 30 days, then deletes it')
    expect(text).not.toContain('until')
  })

  it('an archived workspace reads in the archived voice everywhere: what it holds, the day it is deleted', () => {
    const keptUntil = NOW + 3 * DAY
    const line = archivedSnapshotLine(translate, keptUntil)
    expect(line).toBe(
      `A read-only snapshot of its files, chats and terminal history. Unarchive before ${formatShortDate(keptUntil)} to open terminals and agents again; after that it’s deleted.`
    )
    // The status and hovercard state line say the same words as the archived view.
    expect(cloudStateDetail('archived', translate, keptUntil)).toBe(line)
    // No sandbox-hours sentence for a workspace that's already archived.
    expect(line).not.toContain('sandbox hours')
    // An older control plane without a date: the 30-day rule, never an invented date.
    expect(cloudStateDetail('archived', translate)).toContain('within 30 days of archiving')
  })
})
