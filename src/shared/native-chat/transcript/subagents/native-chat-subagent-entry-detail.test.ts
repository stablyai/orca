import { describe, expect, it } from 'vitest'
import { subagentMessageText } from './native-chat-subagent-entry-detail'

describe('subagentMessageText', () => {
  it('keeps code-span contents literal while stripping marks elsewhere', () => {
    expect(subagentMessageText('**Done.** Read `~/.config` and `src/__tests__/*.ts`')).toBe(
      'Done. Read ~/.config and src/__tests__/*.ts'
    )
  })

  it('keeps link syntax inside a code span and unwraps a link around one', () => {
    expect(subagentMessageText('[`a*b`](https://x.dev) and `[c](https://y.dev)`')).toBe(
      'a*b and [c](https://y.dev)'
    )
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
