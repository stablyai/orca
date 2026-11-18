import { describe, expect, it } from 'vitest'
import { CardExpressionError, compileCardExpression } from './card-expression'

const facts = {
  ws: { name: 'a', branch: 'b', tags: ['x'] },
  review: null,
  options: { style: 'compact' }
}
const run = (source: string, scope: Record<string, unknown> = facts): unknown =>
  compileCardExpression(source).evaluate(scope)

describe('card expressions', () => {
  it('evaluates the rules cards need', () => {
    expect(
      run(
        "ws.branch != '' && (options.style != 'compact' || ws.branch != ws.name) ? lower(ws.name) + '!' : null"
      )
    ).toBe('a!')
    expect(run("review.state ?? 'none'")).toBe('none')
    expect(run('len(ws.tags) > 0 && contains(ws.tags, "x")')).toBe(true)
    expect(run('!ws.missing && -1 < 0')).toBe(true)
    expect(run('1 + 2 - 1')).toBe(2)
    expect(run("'#' + 12")).toBe('#12')
  })

  it('reads missing facts as null instead of throwing', () => {
    expect(run('review.number')).toBeNull()
    expect(run('nothing.at.all')).toBeNull()
  })

  it('reports the fact domains it reads', () => {
    expect([
      ...compileCardExpression('ws.name != vars.title && len(review.title) > 0').roots
    ]).toEqual(['ws', 'vars', 'review'])
  })

  it('cannot reach prototypes, constructors or methods', () => {
    for (const source of [
      'ws.constructor',
      'ws.__proto__',
      'ws.name.constructor',
      'constructor',
      '__proto__',
      'ws.toString',
      'ws.tags.constructor',
      'ws.hasOwnProperty'
    ]) {
      expect(run(source), source).toBeNull()
    }
  })

  it('has no way to call values, index by computed keys or build code', () => {
    for (const source of [
      "ws.name('x')",
      "constructor.constructor('return 1')()",
      'ws[0]',
      'eval(1)',
      "Function('x')",
      'toString()',
      'x = 1',
      '`${1}`',
      'import("x")',
      'ws.',
      'a..b',
      ''
    ]) {
      expect(() => compileCardExpression(source), source).toThrow(CardExpressionError)
    }
  })

  it('bounds size and nesting', () => {
    expect(() => compileCardExpression(`${'('.repeat(40)}1${')'.repeat(40)}`)).toThrow(/deeply/)
    expect(() => compileCardExpression(`${'!'.repeat(40)}x`)).toThrow(/deeply/)
    expect(() => compileCardExpression(`${'1+'.repeat(2000)}1`)).toThrow(/too long/)
    expect(() => compileCardExpression(`${'a ? '.repeat(40)}1${' : 0'.repeat(40)}`)).toThrow(
      /deeply/
    )
    expect(() => compileCardExpression(`a ? 1 : ${'b ? 2 : '.repeat(40)}0`)).toThrow(/deeply/)
    expect(compileCardExpression('a ? 1 : b ? 2 : c ? 3 : 0').evaluate({ c: true })).toBe(3)
  })

  it('rejects malformed call arguments', () => {
    for (const source of ['len(x,)', 'len(,)', 'len(x', 'contains(x,,y)']) {
      expect(() => compileCardExpression(source), source).toThrow(CardExpressionError)
    }
    expect(compileCardExpression("contains(x, 'a')").evaluate({ x: 'abc' })).toBe(true)
  })
})
