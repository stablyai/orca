import { describe, expect, test } from 'vitest'
import { applyTextEditsToString, replaceWholeWordInString } from './code-workspace-edit'

describe('applyTextEditsToString', () => {
  test('applies multi-line and same-line edits in bottom-up order without offset drift', () => {
    const source = ['const count = 1', 'const total = count + count', 'return total'].join('\n')
    const next = applyTextEditsToString(source, [
      { startLine: 1, startColumn: 7, endLine: 1, endColumn: 12, newText: 'items' },
      { startLine: 2, startColumn: 15, endLine: 2, endColumn: 20, newText: 'items' },
      { startLine: 2, startColumn: 23, endLine: 2, endColumn: 28, newText: 'items' }
    ])
    expect(next).toBe(['const items = 1', 'const total = items + items', 'return total'].join('\n'))
  })
})

describe('replaceWholeWordInString', () => {
  test('replaces only exact identifier matches', () => {
    const source = 'const foo = fooBar + foo(1)\n'
    const res = replaceWholeWordInString(source, 'foo', 'baz')
    expect(res).toEqual({
      text: 'const baz = fooBar + baz(1)\n',
      count: 2
    })
  })
})
