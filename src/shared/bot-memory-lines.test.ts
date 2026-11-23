import { describe, expect, it } from 'vitest'
import { dropBotMemoryFact, tagBotMemoryChanges } from './bot-memory-lines'

describe('a fact whose spacing is part of its value', () => {
  it('leaves an unmarked line byte for byte at a turn end, and marks one without respacing', () => {
    const before = '# M\n'
    const after = '# M\n2026-11-06:  header  X-Token  · local\n- tab\tsep  ok  \n'
    expect(tagBotMemoryChanges(before, after, null)).toBe(after)
    expect(tagBotMemoryChanges(before, after, 'Slack')).toBe(
      '# M\n2026-11-06:  header  X-Token  · local · from: Slack\n- tab\tsep  ok · from: Slack\n'
    )
    // A claimed source is stripped, and only it.
    expect(tagBotMemoryChanges(before, '# M\n- a  b · from:   me  \n', null)).toBe('# M\n- a  b\n')
    expect(tagBotMemoryChanges(before, '# M\n- a  b · from: me\n', 'Slack')).toBe(
      '# M\n- a  b · from: Slack\n'
    )
  })

  it('gives a respacing the old mark, as before', () => {
    expect(tagBotMemoryChanges('- a  b · from: Slack\n', '- a b\n- c\n', 'Webhook')).toBe(
      '- a b · from: Slack\n- c · from: Webhook\n'
    )
  })

  it.each([
    ['sep is a  b', '# M\n- sep is a b\n'],
    ['sep is a b', '# M\n- sep is a  b\n']
  ])('forgets %j and keeps the same words spaced otherwise', (fact, left) => {
    expect(dropBotMemoryFact('# M\n- sep is a  b\n- sep is a b\n', fact)).toEqual({
      text: left,
      dropped: 1
    })
  })

  it('forgets every line of identical words, as before', () => {
    expect(dropBotMemoryFact('- x\n# A\n- 2026-11-01 x · from: Slack\n', 'x')).toEqual({
      text: '# A\n',
      dropped: 2
    })
  })

  it('handles a long run of spaces in linear time', () => {
    const spaces = ' '.repeat(8_192)
    const line = `- x${spaces}y${spaces}· from:${spaces}me${spaces}\n`
    const started = performance.now()
    expect(tagBotMemoryChanges('', line, null)).toBe(`- x${spaces}y\n`)
    expect(tagBotMemoryChanges('', `- x${spaces}y${spaces}\n`, 'Slack')).toBe(
      `- x${spaces}y · from: Slack\n`
    )
    expect(dropBotMemoryFact(`- x${spaces}y\n- x y\n`, `x${spaces}y`).text).toBe('- x y\n')
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
