import { describe, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import { automationEffectiveZone, automationZoneLabel } from './automation-bot-facts'
import { orderAutomationDetailNotices } from './automation-detail-sections'

vi.mock('@/lib/agent-catalog/agent-catalog', () => ({ getAgentCatalog: () => [] }))

const DESKTOP = { kind: 'desktop' } as const
const RUNTIME = { kind: 'runtime', environmentId: 'env', pairingRevision: 1 } as const
const scheduled = { dtstart: 1, timezone: 'America/New_York', timezoneExplicit: false }

describe('automation schedule zone', () => {
  it('follows the host’s own rule: desktop clock, server saved zone, named zone everywhere', () => {
    expect(automationEffectiveZone(scheduled, DESKTOP)).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    )
    expect(automationEffectiveZone(scheduled, RUNTIME)).toBe('America/New_York')
    expect(automationEffectiveZone({ ...scheduled, timezoneExplicit: true }, DESKTOP)).toBe(
      'America/New_York'
    )
  })

  it('names the zone only when it isn’t the viewer’s, and only for a schedule', () => {
    expect(automationZoneLabel(scheduled, RUNTIME, 'America/New_York')).toBeNull()
    expect(automationZoneLabel(scheduled, RUNTIME, 'Europe/Paris')).toBe('America/New_York')
    expect(
      automationZoneLabel(
        { ...scheduled, dtstart: EVENT_ONLY_SCHEDULE.dtstart },
        RUNTIME,
        'Europe/Paris'
      )
    ).toBeNull()
  })
})

describe('orderAutomationDetailNotices', () => {
  it('puts red before amber before info and shows a shared cause once', () => {
    const ordered = orderAutomationDetailNotices([
      { key: 'info', tone: 'info', content: null },
      { key: 'offline', tone: 'amber', cause: 'host', content: null },
      { key: 'old-host', tone: 'amber', cause: 'host', content: null },
      { key: 'failed', tone: 'red', content: null }
    ])
    expect(ordered.map((notice) => notice.key)).toEqual(['failed', 'offline', 'info'])
  })
})
