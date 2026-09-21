import { expect, it, vi } from 'vitest'
import { normalizePromptField } from './agent-status-field-normalization'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { selectStructuredAgentTurnActivity } from './native-chat-turn-activity'

function status(text: string): AgentJournalRenderItem {
  return {
    itemId: 'status',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'status', text }
  }
}

it('does not trim every preceding status line to select the final activity', () => {
  const text = `${'Previous activity\n'.repeat(500)}Preparing the answer`
  const trim = vi.spyOn(String.prototype, 'trim')
  try {
    expect(selectStructuredAgentTurnActivity([status(text)], 'turn')).toEqual({
      kind: 'description',
      text: 'Preparing the answer'
    })
    expect(trim.mock.calls.length).toBeLessThan(10)
  } finally {
    trim.mockRestore()
  }
})

it('preserves the last nonempty LF-delimited line before prompt normalization', () => {
  const texts = [
    '',
    '\n',
    '\n\n',
    ' \r\n\t',
    'first\rsecond',
    '\nfirst\r\nsecond\r\n',
    'first\n\u00a0\u2003\n',
    'first\n\u2028second\u2029',
    'a\n😀',
    'a\n\ud800',
    'a\n\udc00',
    `a\n${'x'.repeat(199)}😀`,
    `first\n${' '.repeat(3000)}last`,
    'first\n\0\n',
    'first\n\ufeff\n'
  ]
  const alphabet = [
    'a',
    ' ',
    '\n',
    '\r',
    '\t',
    '\u00a0',
    '\u2003',
    '\u2028',
    '\ufeff',
    '😀',
    '\ud800',
    '\udc00'
  ]
  let seed = 57
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  for (let index = 0; index < 1000; index++) {
    let text = ''
    const length = next() % 300
    for (let offset = 0; offset < length; offset++) {
      text += alphabet[next() % alphabet.length]
    }
    texts.push(text)
  }
  for (const text of texts) {
    const line = text
      .split('\n')
      .map((part) => part.trim())
      .findLast((part) => part.length > 0)
    const normalized = line ? normalizePromptField(line) : ''
    const expected = normalized ? { kind: 'description', text: normalized } : null
    expect(selectStructuredAgentTurnActivity([status(text)], 'turn')).toEqual(expected)
    expect(selectStructuredAgentTurnActivity([], 'turn', { turnId: 'turn', text })).toEqual(
      expected
    )
  }
})
