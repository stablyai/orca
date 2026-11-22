import { describe, expect, it } from 'vitest'
import {
  addBotMemoryFact,
  applyBotMemoryChange,
  botMemoryChange,
  dropBotMemoryFact,
  editBotMemoryFact,
  parseBotMemoryFacts,
  tagBotMemoryChanges
} from './bot-memory-lines'

describe('a fact whose spacing is part of its value', () => {
  const TWO = '# M\n- sep is a  b\n- sep is a b\n'

  it('is a different fact from the same words spaced otherwise', () => {
    const { text, dropped } = dropBotMemoryFact(TWO, 'sep is a  b')
    expect([text, dropped]).toEqual(['# M\n- sep is a b\n', 1])
    const change = botMemoryChange(TWO, text)
    expect(change).toEqual({ added: [], removed: [{ line: '- sep is a  b', after: '# M' }] })
    // Putting back what went restores the file exactly.
    expect(applyBotMemoryChange(text, { added: change.removed, removed: [] })).toBe(TWO)
  })

  it('takes the old mark through a collapse of a fact listed twice', () => {
    const before = '- a  b · from: Slack\n- a  b · from: Slack\n'
    const restored = `${before}- a b\n`
    expect(tagBotMemoryChanges(before, restored, 'Webhook', '- a b\n')).toBe(
      `${before}- a b · from: Slack\n`
    )
  })

  it.each([
    ['the owner', '- a  b\n- a  b · from: Slack\n'],
    ['an outsider', '- a  b · from: Slack\n- a  b\n']
  ])(
    'gives a collapse of copies with different marks the outside one, whoever wrote first: %s',
    (_first, before) => {
      expect(tagBotMemoryChanges(before, `${before}- a b\n`, null, '- a b\n')).toBe(
        `${before}- a b · from: Slack\n`
      )
    }
  )

  it('gives a collapse of copies from two outsiders the newest one listed, never the owner', () => {
    const before = '- a  b · from: Slack\n- a  b\n- a  b · from: Webhook\n'
    expect(tagBotMemoryChanges(before, `${before}- a b\n`, null, '- a b\n')).toBe(
      `${before}- a b · from: Slack\n`
    )
  })

  it('keeps a long run of spaces through an add and an edit, and joins lines around it', () => {
    const spaces = ' '.repeat(8_192)
    const added = addBotMemoryFact('', `a${spaces}b`, '2026-11-06')
    expect(added).toBe(`- 2026-11-06 a${spaces}b\n`)
    const [fact] = parseBotMemoryFacts(added)
    expect(editBotMemoryFact(added, fact, `c${spaces}\n${spaces}\t\r\nd${spaces}e`)).toBe(
      `- 2026-11-06 c d${spaces}e\n`
    )
  })

  it('keeps its spaces through a turn-end mark, an edit and an add', () => {
    const before = '# M\n'
    const after = '# M\n2026-11-06:  header  X-Token  · local\n- tab\tsep  ok  \n'
    expect(tagBotMemoryChanges(before, after, null)).toBe(after)
    expect(tagBotMemoryChanges(before, after, 'Slack')).toBe(
      '# M\n2026-11-06:  header  X-Token  · local · from: Slack\n- tab\tsep  ok · from: Slack\n'
    )
    expect(tagBotMemoryChanges(before, '# M\n- a  b · from: me\n', null)).toBe('# M\n- a  b\n')
    const [fact] = parseBotMemoryFacts(TWO)
    expect(editBotMemoryFact(TWO, fact, 'sep is  c').split('\n')[1]).toBe('- sep is  c')
    expect(addBotMemoryFact('', 'two  spaces\n  next line', '2026-11-06')).toBe(
      '- 2026-11-06 two  spaces next line\n'
    )
  })
})
