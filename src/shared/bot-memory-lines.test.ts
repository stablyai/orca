import { describe, expect, it } from 'vitest'
import {
  addBotMemoryFact,
  editBotMemoryFact,
  parseBotMemoryFacts,
  tagBotMemoryChanges
} from './bot-memory-lines'
import { applyBotMemoryLines, dropBotMemoryFact } from './bot-memory-line-copies'

describe('a fact whose spacing is part of its value', () => {
  const TWO = '# M\n- sep is a  b\n- sep is a b\n'

  it.each([
    ['sep is a  b', '# M\n- sep is a b\n', '# M'],
    ['sep is a b', '# M\n- sep is a  b\n', '- sep is a  b']
  ])('is another fact from the same words spaced otherwise: %j', (fact, left, after) => {
    const { text, dropped } = dropBotMemoryFact(TWO, fact)
    expect([text, dropped]).toEqual([left, { line: `- ${fact}`, after }])
    // Putting back what went restores the file exactly.
    expect(applyBotMemoryLines(text, { added: [dropped!], removed: [] }).text).toBe(TWO)
  })

  it('takes out one copy of a fact stated twice, and puts it back where it was', () => {
    const file = '- x\n# A\n- x · from: Slack\n'
    const dropped = dropBotMemoryFact(file, 'x')
    expect(dropped).toEqual({
      text: '# A\n- x · from: Slack\n',
      dropped: { line: '- x', after: null }
    })
    const { text, made } = applyBotMemoryLines(file, {
      added: [],
      removed: [dropped.dropped!]
    })
    expect([text, made.removed]).toEqual([dropped.text, [{ line: '- x', after: null }]])
    expect(applyBotMemoryLines(text, { added: made.removed, removed: [] }).text).toBe(file)
  })

  it('leaves an unmarked line byte for byte at a turn end, and marks one without respacing', () => {
    const before = '# M\n'
    const after = '# M\n2026-11-06:  header  X-Token  · local\n- tab\tsep  ok  \n'
    expect(tagBotMemoryChanges(before, after, null)).toBe(after)
    expect(tagBotMemoryChanges(before, after, 'Slack')).toBe(
      '# M\n2026-11-06:  header  X-Token  · local · from: Slack\n- tab\tsep  ok · from: Slack\n'
    )
    expect(tagBotMemoryChanges(before, '# M\n- a  b · from: me\n', null)).toBe('# M\n- a  b\n')
  })

  it('gives a respacing the old mark and an unrelated new fact the turn label', () => {
    const before = '- a  b · from: Slack\n'
    expect(tagBotMemoryChanges(before, '- a b\n- c\n', null)).toBe('- a b · from: Slack\n- c\n')
    expect(tagBotMemoryChanges(before, '- a b\n- c\n', 'Webhook')).toBe(
      '- a b · from: Slack\n- c · from: Webhook\n'
    )
  })

  it.each([
    ['the owner', '- a  b\n- a   b · from: Slack\n'],
    ['an outsider', '- a   b · from: Slack\n- a  b\n']
  ])('gives a respacing of copies with different marks the outside one: %s first', (_, before) => {
    expect(tagBotMemoryChanges(before, '- a b\n', null)).toBe('- a b · from: Slack\n')
  })

  it('keeps a long run of spaces through an add and an edit, and joins lines around it', () => {
    const spaces = ' '.repeat(8_192)
    const started = performance.now()
    const added = addBotMemoryFact('', `a${spaces}b`, '2026-11-06')
    expect(added).toBe(`- 2026-11-06 a${spaces}b\n`)
    const [fact] = parseBotMemoryFacts(added)
    expect(editBotMemoryFact(added, fact, `c${spaces}\n${spaces}\t\r\nd${spaces}e`)).toBe(
      `- 2026-11-06 c d${spaces}e\n`
    )
    expect(tagBotMemoryChanges('', `- x${spaces}\n${spaces}y\n`, null)).toBe(
      `- x${spaces}\n${spaces}y\n`
    )
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
