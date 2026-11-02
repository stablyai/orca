import { expect, it, vi } from 'vitest'
import { selectStructuredAgentTurnActivity } from './native-chat-turn-activity'

it('does not trim every preceding activity line to select the final activity', () => {
  const text = `${'Previous activity\n'.repeat(500)}Preparing the answer`
  const trim = vi.spyOn(String.prototype, 'trim')
  try {
    expect(selectStructuredAgentTurnActivity([], 'turn', { turnId: 'turn', text })).toEqual({
      kind: 'description',
      text: 'Preparing the answer'
    })
    expect(trim.mock.calls.length).toBeLessThan(10)
  } finally {
    trim.mockRestore()
  }
})

it('preserves the last nonempty LF-delimited line before prompt normalization', () => {
  const cases: [string, string | null][] = [
    ['', null],
    ['\n', null],
    ['\n\n', null],
    [' \r\n\t', null],
    ['first\rsecond', 'first second'],
    ['\nfirst\r\nsecond\r\n', 'second'],
    ['first\n\u00a0\u2003\n', 'first'],
    ['first\n\u2028second\u2029', 'second'],
    ['a\n😀', '😀'],
    ['a\n\ud800', '\ud800'],
    ['a\n\udc00', '\udc00'],
    [`a\n${'x'.repeat(199)}😀`, 'x'.repeat(199)],
    [`first\n${' '.repeat(3000)}last`, 'last'],
    ['first\n\0\n', '\0'],
    ['first\n\ufeff\n', 'first']
  ]
  for (const [text, expected] of cases) {
    expect(selectStructuredAgentTurnActivity([], 'turn', { turnId: 'turn', text })).toEqual(
      expected ? { kind: 'description', text: expected } : null
    )
  }
})
