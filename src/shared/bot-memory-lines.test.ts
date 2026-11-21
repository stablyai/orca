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
