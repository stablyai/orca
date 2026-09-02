import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractDetailsSummaryHtml,
  isEditableDetailsHtmlBlock,
  matchDetailsHtmlBlock,
  parseDetailsAttributes,
  parseToggleHeadingVariant,
  type DetailsHtmlBlock
} from './details-markdown-html'

function nestedToggles(depth: number): string {
  let html = '<details class="orca-details" open>\n<summary>leaf</summary>\n\nBody\n\n</details>'
  for (let level = depth - 1; level > 0; level -= 1) {
    html = `<details class="orca-details" open>\n<summary>level ${level}</summary>\n\n${html}\n\n</details>`
  }
  return html
}

function isEditableHtml(html: string): boolean {
  const block = matchDetailsHtmlBlock(html, 0)
  return block !== null && isEditableDetailsHtmlBlock(block)
}

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
      inner: `<summary>${'Heading line\n'.repeat(1_000)}</summary><p>Body</p>`
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
      inner: '<summary>Toggle</summary><p>Body</p>'
    }
    const unsupportedHeading6: DetailsHtmlBlock = {
      raw: '',
      openingAttributes: ' data-orca-toggle="heading-6"',
      inner: '<summary>Toggle</summary><p>Body</p>'
    }

    expect(isEditableDetailsHtmlBlock(editableHeading5)).toBe(true)
    expect(isEditableDetailsHtmlBlock(unsupportedHeading6)).toBe(false)
  })

  it('accepts nested toggles whose descendants are all editable', () => {
    expect(isEditableHtml(nestedToggles(2))).toBe(true)
    expect(isEditableHtml(nestedToggles(16))).toBe(true)
  })

  it('bounds each of many sibling nested toggles independently', () => {
    const siblings = (count: number, extra = ''): string =>
      Array.from(
        { length: count },
        (_, index) =>
          `<details class="orca-details"${extra}>\n<summary>sibling ${index}</summary>\n\nBody\n\n</details>`
      ).join('\n\n')
    const wrap = (body: string): string =>
      `<details class="orca-details">\n<summary>Outer</summary>\n\n${body}\n\n</details>`

    expect(isEditableHtml(wrap(siblings(40)))).toBe(true)
    // A single non-editable sibling must still reject, so sharing fence ranges
    // cannot make later siblings inherit an earlier sibling's boundaries.
    expect(isEditableHtml(wrap(`${siblings(20)}\n\n${siblings(1, ' id="x"')}`))).toBe(false)
  })

  it('rejects a toggle whose nested toggle is not itself editable', () => {
    const block: DetailsHtmlBlock = {
      raw: '',
      openingAttributes: ' class="orca-details"',
      inner: '<summary>Outer</summary><details id="x"><summary>Inner</summary><p>Body</p></details>'
    }

    expect(isEditableDetailsHtmlBlock(block)).toBe(false)
  })

  it('rejects nesting past the recursion guard instead of recursing without bound', () => {
    expect(isEditableHtml(nestedToggles(17))).toBe(false)
    expect(isEditableHtml(nestedToggles(400))).toBe(false)
  })

  it('rejects unbalanced and non-toggle tags that start with details', () => {
    const unbalanced: DetailsHtmlBlock = {
      raw: '',
      openingAttributes: '',
      inner: '<summary>Outer</summary><details><summary>Inner</summary>'
    }
    const lookalike: DetailsHtmlBlock = {
      raw: '',
      openingAttributes: '',
      inner: '<summary>Outer</summary><detailsish>Body</detailsish>'
    }

    expect(isEditableDetailsHtmlBlock(unbalanced)).toBe(false)
    expect(isEditableDetailsHtmlBlock(lookalike)).toBe(false)
  })
})
