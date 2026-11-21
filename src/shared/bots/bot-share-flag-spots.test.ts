import { expect, it } from 'vitest'
import { botShareFlagSpot } from './bot-share-flag-spots'

const daily = (prompt: string) => ({
  id: 's1',
  name: 'Daily',
  prompt,
  rrule: 'FREQ=DAILY;BYHOUR=9',
  results: 'chat' as const
})

it('places an automation flag on the automation shared, not one with the same name', () => {
  // Two automations are named Daily; only the second is shared, and its prompt holds the secret.
  const candidate = {
    bot: { tools: [], schedules: [daily('token xoxb-0000EXAMPLE')], eventSuggestions: [] },
    available: {
      skills: [],
      schedules: [
        { automationId: 'daily-left-out', name: 'Daily', rrule: 'FREQ=DAILY;BYHOUR=9' },
        { automationId: 'daily-with-secret', name: 'Daily', rrule: 'FREQ=DAILY;BYHOUR=9' }
      ]
    },
    automationIds: { schedules: ['daily-with-secret'], eventSuggestions: [] }
  }
  const spot = botShareFlagSpot(
    { where: 'bot.json#schedules.0.prompt', line: 1, kind: 'secret' },
    candidate
  )
  expect(spot.part).toBe('schedule:daily-with-secret')
})
