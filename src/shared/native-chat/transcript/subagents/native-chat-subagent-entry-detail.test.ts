import { describe, expect, it } from 'vitest'
import { subagentMessageText } from './native-chat-subagent-entry-detail'

describe('subagentMessageText', () => {
  it('strips markup around code spans and keeps their contents literal', () => {
    expect(
      subagentMessageText(
        '**Done.** Read `src/__tests__/*.ts`, [`a*b`](https://x.dev), and `[c](https://y.dev)`'
      )
    ).toBe('Done. Read src/__tests__/*.ts, a*b, and [c](https://y.dev)')
  })

  it('pairs only backtick runs of equal length', () => {
    expect(subagentMessageText('Use `a*b` and ``a`b``')).toBe('Use a*b and a`b')
  })

  it('does not pair an unmatched backtick with one in a later block', () => {
    expect(subagentMessageText('Run `deploy\n\nthen read `src/__tests__/*.ts`')).toBe(
      'Run deploy\n\nthen read src/__tests__/*.ts'
    )
    expect(subagentMessageText('- run `foo\n- read **bar** `x`')).toBe('run foo\nread bar x')
    expect(subagentMessageText('Title `a\n===\n**see** `b*c`')).toBe('Title a\n===\nsee b*c')
  })

  it('does not open a code span at an escaped backtick', () => {
    expect(subagentMessageText('Ran \\`foo and **bar** `baz`')).toBe('Ran \\foo and bar baz')
  })
})
