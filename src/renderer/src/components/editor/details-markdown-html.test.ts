import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractDetailsSummaryHtml,
  isEditableDetailsHtmlBlock,
  parseDetailsAttributes,
  parseToggleHeadingVariant,
  type DetailsHtmlBlock
} from './details-markdown-html'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('details markdown html', () => {
  it('extracts leading summary html without regex capture', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const inner = `\n<SUMMARY>${'Heading line\n'.repeat(1_000)}</SUMMARY><p>Body</p>`

    const summary = extractDetailsSummaryHtml(inner)

    expect(summary?.content).toContain('Heading line')
    expect(summary?.rawLength).toBe(inner.indexOf('<p>Body</p>'))
    const usedSummaryCapture = matchSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        pattern.source.startsWith('^\\s*<summary') &&
        pattern.source.includes('[\\s\\S]')
    )
    expect(usedSummaryCapture).toBe(false)
  })

  it('accepts editable details blocks with newline-heavy summaries without summary matching', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const block: DetailsHtmlBlock = {
      raw: '',
      openingAttributes: '',
      inner: `<summary>${'Heading line\n'.repeat(1_000)}</summary><p>Body</p>`,
      hasNestedDetails: false
    }

    expect(isEditableDetailsHtmlBlock(block)).toBe(true)
    const usedSummaryCapture = matchSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        pattern.source.startsWith('^\\s*<summary') &&
        pattern.source.includes('[\\s\\S]')
    )
    expect(usedSummaryCapture).toBe(false)
  })

  it('accepts heading-5 toggle variants and rejects unsupported levels', () => {
    expect(parseToggleHeadingVariant('heading-5')).toBe('heading-5')
    expect(parseToggleHeadingVariant('heading-6')).toBeNull()
    expect(parseDetailsAttributes(' data-orca-toggle="heading-5"')).toMatchObject({
      variant: 'heading-5'
    })
    expect(parseDetailsAttributes(' data-orca-toggle="heading-6"')).toMatchObject({
      variant: null
    })

    const editableHeading5: DetailsHtmlBlock = {
      raw: '',
      openingAttributes: ' data-orca-toggle="heading-5"',
      inner: '<summary>Toggle</summary><p>Body</p>',
      hasNestedDetails: false
    }
    const unsupportedHeading6: DetailsHtmlBlock = {
      raw: '',
      openingAttributes: ' data-orca-toggle="heading-6"',
      inner: '<summary>Toggle</summary><p>Body</p>',
      hasNestedDetails: false
    }

    expect(isEditableDetailsHtmlBlock(editableHeading5)).toBe(true)
    expect(isEditableDetailsHtmlBlock(unsupportedHeading6)).toBe(false)
  })
})
