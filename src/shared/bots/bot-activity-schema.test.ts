import { describe, expect, it } from 'vitest'
import { BotActivityViewSchema } from './bot-activity-schema'

const automation = {
  id: 'a1',
  name: 'Digest',
  enabled: true,
  nextRunAt: 0,
  updatedAt: 1,
  dtstart: 0,
  rrule: '',
  workspaceId: null
}

function parsedLastRuns(lastRuns: unknown[]): unknown[] {
  const activity = BotActivityViewSchema.parse({
    workers: [],
    inProgress: [],
    completed: [],
    automations: lastRuns.map((lastRun, index) => ({
      key: `a${index}`,
      failing: false,
      automation: { ...automation, id: `a${index}` },
      lastRun
    })),
    waits: []
  })
  return activity.automations.map((row) => row.lastRun)
}

describe('BotActivityViewSchema lastRun', () => {
  it("keeps a known last run and drops one whose status this phone doesn't know, keeping its row", () => {
    expect(
      parsedLastRuns([
        { status: 'completed', at: 5 },
        { status: 'a_status_from_a_newer_host', at: 6 }
      ])
    ).toEqual([{ status: 'completed', at: 5 }, undefined])
  })
})
