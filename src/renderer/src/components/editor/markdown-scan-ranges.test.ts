import { afterEach, describe, expect, it, vi } from 'vitest'
import { findDetailsBlockStart } from './details-markdown-html'
import { markdownCodeSpanRanges, markdownFenceRanges } from './markdown-scan-ranges'
import * as markdownScanRanges from './markdown-scan-ranges'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('markdownCodeSpanRanges', () => {
  it('reports a span whose backtick run closes on an equal run', () => {
    expect(markdownCodeSpanRanges('a `<details>` b')).toEqual([[2, 13]])
  })

  it('keeps a span that contains a blank line', () => {
    expect(markdownCodeSpanRanges('text `a\n\nb` tail')).toEqual([[5, 11]])
  })

  it('reports no span for backticks inside a fenced block', () => {
    expect(markdownCodeSpanRanges(['```', 'a `b` c', '```'].join('\n'))).toEqual([])
  })

  it('does not pair a fence backtick with a later prose backtick', () => {
    const content = ['~~~', 'x = `abc', '~~~', '', 'prose with `code` here'].join('\n')
    const spans = markdownCodeSpanRanges(content)

    expect(spans).toEqual([[29, 35]])
    expect(content.slice(29, 35)).toBe('`code`')
  })

  it('does not run a span through a four-backtick fence closer', () => {
    const content = ['```', 'code', '````', '', 'tail', '', '```', 'more', '```'].join('\n')

    expect(markdownCodeSpanRanges(content)).toEqual([])
  })
})

describe('findDetailsBlockStart with fenced content', () => {
  it('finds a details block after a fence whose content holds an unpaired backtick', () => {
    const content = [
      '~~~',
      'x = `abc',
      '~~~',
      '',
      '<details>',
      '<summary>S</summary>',
      '',
      'body',
      '',
      '</details>',
      '',
      'prose with `code` here'
    ].join('\n')

    expect(findDetailsBlockStart(content)).toBe(content.indexOf('<details>'))
  })

  it('finds a details block between a four-backtick closer and a later fence', () => {
    const content = [
      '```',
      'code',
      '````',
      '',
      '<details>',
      '<summary>S</summary>',
      '',
      'x',
      '',
      '</details>',
      '',
      '```',
      'more',
      '```'
    ].join('\n')

    expect(findDetailsBlockStart(content)).toBe(content.indexOf('<details>'))
  })

  it('skips a details mention inside a code span that spans a blank line', () => {
    expect(findDetailsBlockStart('text `a\n\n<details>b` tail')).toBe(-1)
  })
})

describe('findDetailsBlockStart cost on documents without a toggle', () => {
  // marked calls the start hook once per paragraph over the remaining source,
  // so a full range scan per call makes parsing quadratic in document size.
  // A wall-clock bound can pass with the early exit removed on a fast machine,
  // so the guard asserts the scan functions are never invoked instead.
  it('never scans fence or code-span ranges for a toggle-free document', () => {
    const fenceSpy = vi.spyOn(markdownScanRanges, 'markdownFenceRanges')
    const codeSpanSpy = vi.spyOn(markdownScanRanges, 'markdownCodeSpanRanges')
    const paragraphs = Array.from(
      { length: 300 },
      (_, index) => `Paragraph ${index} ${'lorem ipsum dolor sit amet '.repeat(25)}`
    )
    const document = paragraphs.join('\n\n')
    expect(document.length).toBeGreaterThan(200_000)

    let offset = 0
    for (const paragraph of paragraphs) {
      expect(findDetailsBlockStart(document.slice(offset))).toBe(-1)
      offset += paragraph.length + 2
    }

    expect(fenceSpy).not.toHaveBeenCalled()
    expect(codeSpanSpy).not.toHaveBeenCalled()
  })

  it('scans ranges only for calls whose remaining source holds the toggle', () => {
    const fenceSpy = vi.spyOn(markdownScanRanges, 'markdownFenceRanges')
    const codeSpanSpy = vi.spyOn(markdownScanRanges, 'markdownCodeSpanRanges')
    // The toggle is the trailing paragraph, so every remaining-source slice
    // still contains it — all 300 calls scan, none is skipped by the guard.
    const paragraphs = Array.from({ length: 300 }, (_, index) => `Paragraph ${index}.`)
    paragraphs.push('<details>\n<summary>S</summary>\n\nbody\n\n</details>')
    const document = paragraphs.join('\n\n')

    let offset = 0
    let found = -1
    for (const paragraph of paragraphs) {
      const relative = findDetailsBlockStart(document.slice(offset))
      if (relative !== -1) {
        found = offset + relative
      }
      offset += paragraph.length + 2
    }

    expect(found).toBe(document.indexOf('<details>'))
    expect(fenceSpy).toHaveBeenCalledTimes(paragraphs.length)
    expect(codeSpanSpy).toHaveBeenCalledTimes(paragraphs.length)
  })

  // Opt-in only: `ORCA_DETAILS_SCAN_BENCH=1 pnpm test markdown-scan-ranges` to
  // read wall-clock cost. Not a CI gate — the scan-count assertions above are.
  it.skipIf(process.env.ORCA_DETAILS_SCAN_BENCH !== '1')(
    'benchmarks a large toggle-free document',
    () => {
      const paragraphs = Array.from(
        { length: 300 },
        (_, index) => `Paragraph ${index} ${'lorem ipsum dolor sit amet '.repeat(25)}`
      )
      const document = paragraphs.join('\n\n')

      const started = performance.now()
      let offset = 0
      for (const paragraph of paragraphs) {
        expect(findDetailsBlockStart(document.slice(offset))).toBe(-1)
        offset += paragraph.length + 2
      }

      process.stdout.write(`${JSON.stringify({ elapsedMs: performance.now() - started })}\n`)
    }
  )

  it('still finds a toggle that follows a long run of prose', () => {
    const prose = Array.from({ length: 300 }, (_, index) => `Paragraph ${index}.`).join('\n\n')
    const document = `${prose}\n\n<details>\n<summary>S</summary>\n\nbody\n\n</details>`

    expect(findDetailsBlockStart(document)).toBe(document.indexOf('<details>'))
  })

  it('finds an uppercase opening tag the lowercase fast path misses', () => {
    const document = 'Prose paragraph.\n\n<DETAILS>\n<summary>S</summary>\n\nbody\n\n</DETAILS>'

    expect(findDetailsBlockStart(document)).toBe(document.indexOf('<DETAILS>'))
  })
})

describe('markdownFenceRanges', () => {
  it('covers the opening delimiter, content, and closing delimiter', () => {
    const content = ['```', 'x', '```', ''].join('\n')

    expect(markdownFenceRanges(content)).toEqual([[0, 10]])
  })

  it('runs an unterminated fence to the end of the content', () => {
    const content = ['```', 'x', 'y'].join('\n')

    expect(markdownFenceRanges(content)).toEqual([[0, content.length]])
  })

  it('does not close a fence on a closer followed by a non-breaking space', () => {
    // CommonMark 4.5: a closing fence may be followed only by spaces or tabs.
    // U+00A0 is not one, so this line must not close the open fence, and a
    // `<details>` further down stays inside the still-open fenced range.
    const content = ['```', `\`\`\` `, '<details>', '```'].join('\n')

    expect(markdownFenceRanges(content)).toEqual([[0, content.length]])
  })
})

describe('findDetailsBlockStart with a non-breaking space after a fence closer', () => {
  it('does not rewrite a details block that is still inside an open fence', () => {
    const content = [
      '```',
      `\`\`\` `,
      '<details>',
      '<summary>S</summary>',
      '',
      'body',
      '',
      '</details>',
      '```'
    ].join('\n')

    expect(findDetailsBlockStart(content)).toBe(-1)
  })
})
