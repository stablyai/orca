import { expect, it } from 'vitest'
import { searchPierreDiff } from './pierre-diff-search'

function search(text: string, query: string, options = {}, replacement = '') {
  return searchPierreDiff({
    text,
    query: { text: query, regex: false, matchCase: false, wholeWord: false, ...options },
    replacement
  })
}

it('searches multiline text and maps CRLF positions', () => {
  const result = search('before\r\nfirst\r\nsecond\r\nafter', 'first\r\nsecond')
  expect(result.matches.map((match) => match.range)).toEqual([
    { start: { line: 1, character: 0 }, end: { line: 2, character: 6 } }
  ])
})

it('supports case, Unicode whole words and literal regex characters', () => {
  expect(search('Cat cat catapult caté', 'cat', { wholeWord: true }).matches).toHaveLength(2)
  expect(search('Cat cat', 'cat', { matchCase: true }).matches).toHaveLength(1)
  expect(search('a.b axb', 'a.b').matches).toHaveLength(1)
})

it('expands capture replacements with lookbehind and named groups', () => {
  const text = 'prefix key:42 suffix'
  const pattern = '(?<=key:)(?<number>\\d+)'
  const template = "$<number>-$1-$$-$&-$`-$'"
  const match = search(text, pattern, { regex: true }, template).matches[0]
  const replaced = text.slice(0, match.start) + match.replacement + text.slice(match.end)
  expect(replaced).toBe(text.replace(new RegExp(pattern, 'gmu'), template))
})

it('reports invalid expressions and makes progress through zero-width Unicode matches', () => {
  expect(search('text', '[', { regex: true }).errorCode).toBe('invalid-regex')
  expect(search('😀a', '(?=.)', { regex: true }).matches.map((match) => match.start)).toEqual([
    0, 2
  ])
})

it('caps results without allowing replace-all to silently replace a prefix', () => {
  const result = search('x '.repeat(10_002), 'x')
  expect(result.matches).toHaveLength(10_000)
  expect(result.truncated).toBe(true)
})
