import { describe, expect, it } from 'vitest'
import { parseForcedSearchQuery } from './tab-create-entry-forced-search'

describe('parseForcedSearchQuery', () => {
  it.each([
    ['react', { forced: false, query: 'react' }],
    [' react ', { forced: false, query: 'react' }],
    [' ?react', { forced: false, query: '?react' }],
    ['?react hooks', { forced: true, query: 'react hooks' }],
    ['??foo', { forced: true, query: '?foo' }],
    ['?https://x.dev', { forced: true, query: 'https://x.dev' }],
    ['?', { forced: true, query: '' }],
    ['?   ', { forced: true, query: '' }]
  ])('parses %j', (input, expected) => {
    expect(parseForcedSearchQuery(input)).toEqual(expected)
  })
})
