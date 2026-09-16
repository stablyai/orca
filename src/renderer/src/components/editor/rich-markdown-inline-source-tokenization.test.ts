// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { getRichMarkdownRoundTripOutput } from './markdown-round-trip'

describe('inline source tokens at text boundaries', () => {
  for (const prefix of ['plain ', '中文', '(', '*emphasis* ']) {
    it.each(['<kbd>Key</kbd>', '[[note|Label]]', '<sup><a href="./ref.md">[12]</a></sup>'])(
      `recognizes %j after ${JSON.stringify(prefix)}`,
      (fragment) => {
        const source = `${prefix}${fragment} suffix`
        expect(getRichMarkdownRoundTripOutput(source)).toBe(source)
      }
    )
  }

  it('preserves a large paragraph with dense malformed links and embedded source tokens', () => {
    const prose = 'Text [[]] with a blank [[alias|]] and ordinary prose. '.repeat(1000)
    const source = `${prose}<kbd>Key</kbd> [[note|Label]] ${prose.trim()}`
    expect(getRichMarkdownRoundTripOutput(source)).toBe(source)
  })
})
