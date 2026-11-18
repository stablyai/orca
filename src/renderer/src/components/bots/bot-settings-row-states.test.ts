import { describe, expect, it } from 'vitest'
import { lookAroundLine, memoryLine, namesLine, toolsLine } from './bot-settings-row-states'

// Local wall-clock times, so "today" and "yesterday" hold in any time zone.
const now = new Date(2026, 10, 10, 15, 0).getTime()
const today = new Date(2026, 10, 10, 12, 4).getTime()
const yesterday = new Date(2026, 10, 9, 16, 12).getTime()
const earlier = new Date(2026, 9, 29, 9, 0).getTime()
const look = { on: true, every: 'every-4h', weekdaysOnly: true, focus: '' } as const

describe('bot settings state lines', () => {
  it('says when Look around runs and when it last looked', () => {
    expect(lookAroundLine(look, today, now)).toBe(
      'Every 4 hours, 8 AM to 8 PM · last looked 12:04 PM'
    )
    expect(lookAroundLine(look, yesterday, now)).toBe(
      'Every 4 hours, 8 AM to 8 PM · last looked yesterday 4:12 PM'
    )
    expect(lookAroundLine({ ...look, every: 'mornings' }, earlier, now)).toBe(
      'Each morning at 8 AM · last looked Oct 29'
    )
    expect(lookAroundLine(look, undefined, now)).toBe('Every 4 hours, 8 AM to 8 PM')
    expect(lookAroundLine({ ...look, on: false }, today, now)).toBe('Off')
  })

  it('counts memory topic files', () => {
    expect(memoryLine(6)).toBe('MEMORY.md and 6 topic files')
    expect(memoryLine(0)).toBe('MEMORY.md')
    expect(memoryLine(null)).toBe('MEMORY.md')
  })

  it('names the bot’s own tools, then counts the ones from its agent', () => {
    const own = (name: string) => ({ name, detail: `npx ${name}`, remote: false })
    const inherited = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
    expect(
      toolsLine(
        { agent: 'claude', own: [own('sentry'), own('playwright')], inherited },
        'Claude Code',
        'en'
      )
    ).toBe('Sentry, Playwright · 3 more from Claude Code')
    expect(toolsLine({ agent: 'claude', own: [], inherited }, 'Claude Code', 'en')).toBe(
      '3 from Claude Code'
    )
    expect(toolsLine({ agent: 'claude', own: [], inherited: [] }, 'Claude Code', 'en')).toBe('None')
    expect(toolsLine({ agent: 'grok', unsupported: true }, 'Grok', 'en')).toBe('Set up in Grok')
    expect(toolsLine(null, 'Claude Code', 'en')).toBeNull()
  })

  it('lists connectors and skills', () => {
    expect(namesLine(['Slack', 'GitHub'], 'en')).toBe('Slack, GitHub')
    expect(namesLine([], 'en')).toBe('None')
  })
})
