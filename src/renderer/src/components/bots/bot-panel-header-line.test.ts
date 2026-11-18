import { describe, expect, it } from 'vitest'
import { botQuietLine } from './BotPanelHeader'

const NOW = new Date(2026, 10, 13, 12, 0).getTime()
const AT = new Date(2026, 10, 13, 15, 5).getTime()

describe('botQuietLine', () => {
  it('says what is running instead of Idle, whatever runs next', () => {
    expect(
      botQuietLine({ running: 'Mentions triage', next: { name: 'DM sweep', at: AT } }, NOW)
    ).toEqual({ text: 'Running Mentions triage', short: null })
  })

  it('says the next time first, and keeps only the time where the panel is narrow', () => {
    const line = botQuietLine({ running: null, next: { name: 'Mentions triage', at: AT } }, NOW)

    expect(line.text).toMatch(/^Idle · next 3:05\sPM · Mentions triage$/)
    expect(line.short).toMatch(/^Next 3:05\sPM$/)
  })

  it('says Idle alone with nothing next', () => {
    expect(botQuietLine({ running: null, next: null }, NOW)).toEqual({
      text: 'Idle',
      short: null
    })
  })
})
