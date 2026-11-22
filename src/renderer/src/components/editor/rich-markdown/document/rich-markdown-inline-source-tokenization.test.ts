// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { getRichMarkdownRoundTripOutput } from '../../markdown/render-mode/markdown-round-trip'

describe('inline source tokens at text boundaries', () => {
  it('preserves a large paragraph with dense malformed links and embedded source tokens', () => {
    const prose = 'Text [[]] with a blank [[alias|]] and ordinary prose. '.repeat(1000)
    const source = `${prose}<kbd>Key</kbd> [[note|Label]] ${prose.trim()}`
    expect(getRichMarkdownRoundTripOutput(source)).toBe(source)
  })
})
