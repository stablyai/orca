import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'
import * as roundTrip from './markdown-round-trip'

// Pushes a body past the `body.length <= 50_000` round-trip cap in
// `markdown-rich-mode.ts`, so only the cheap validator decides the verdict.
const oversizePrefix = 'An ordinary paragraph.\n\n'.repeat(2500)

const declarations = [
  '<!DOCTYPE html>',
  '<![CDATA[x]]>',
  '<!ENTITY foo "bar">',
  '\\<!DOCTYPE html>'
]

afterEach(() => vi.restoreAllMocks())

describe('HTML-like declarations the source codec does not tokenize', () => {
  it.each(declarations)('rewrites %s on save, so rich mode must refuse it', (declaration) => {
    expect(roundTrip.getRichMarkdownRoundTripOutput(declaration)).toContain('&lt;!')
  })

  it.each(declarations)('blocks %s on its own at every size', (declaration) => {
    const small = `Body.\n\n${declaration}\n`
    expect(small.length).toBeLessThan(50_000)
    expect(getMarkdownRichModeUnsupportedReason(small)).toBe('html-or-jsx')

    const large = `${oversizePrefix}${declaration}\n`
    expect(large.length).toBeGreaterThan(50_000)
    expect(getMarkdownRichModeUnsupportedReason(large)).toBe('html-or-jsx')
  })

  it('blocks a declaration beside a comment without a full editor probe', () => {
    const probe = vi.spyOn(roundTrip, 'getRichMarkdownRoundTripOutput')
    const content = `${oversizePrefix}<!-- c -->\n\n<!DOCTYPE html>\n`
    expect(content.length).toBeGreaterThan(50_000)
    expect(getMarkdownRichModeUnsupportedReason(content)).toBe('html-or-jsx')
    expect(probe).not.toHaveBeenCalled()
  })

  it('still admits the same document without the declaration', () => {
    expect(getMarkdownRichModeUnsupportedReason(`${oversizePrefix}<!-- c -->\n`)).toBeNull()
  })

  // `<!` reaches the save path as an escape even outside a declaration, so the
  // large-document guard rejects the literal, not just the declaration shapes.
  it.each(['a <!b', 'cat <<!', '2 <! 3'])('blocks the bare literal in %j', (needle) => {
    expect(roundTrip.getRichMarkdownRoundTripOutput(needle)).toContain('&lt;')
    expect(getMarkdownRichModeUnsupportedReason(`${oversizePrefix}<!-- c -->\n\n${needle}\n`)).toBe(
      'html-or-jsx'
    )
  })
})
