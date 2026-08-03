import { describe, expect, it } from 'vitest'
import { extractFilePathProseSpans } from './file-path-prose-spans'

const spanTexts = (text: string): string[] =>
  extractFilePathProseSpans(text).map((span) => text.slice(span.startIndex, span.endIndex))

describe('extractFilePathProseSpans', () => {
  it('finds a relative path in prose', () => {
    expect(spanTexts('Design doc written: docs/mobile-chat-file-path-links.md .')).toContain(
      'docs/mobile-chat-file-path-links.md'
    )
  })

  it('finds an absolute POSIX path in prose', () => {
    expect(spanTexts('wrote /Users/me/repo/src/index.ts for you')).toContain(
      '/Users/me/repo/src/index.ts'
    )
  })

  it('keeps a line and column suffix in the span', () => {
    expect(spanTexts('see src/components/Button.tsx:12:7 here')).toContain(
      'src/components/Button.tsx:12:7'
    )
  })

  it('finds multiple paths in one run', () => {
    const spans = spanTexts('compare src/a.ts and src/b.ts now')
    expect(spans).toContain('src/a.ts')
    expect(spans).toContain('src/b.ts')
  })

  it('preserves balanced route segments and trims prose wrappers', () => {
    expect(spanTexts('open (shop)/page.tsx and [id]/page.tsx')).toEqual([
      '(shop)/page.tsx',
      '[id]/page.tsx'
    ])
    expect(spanTexts('open ((shop)/page.tsx) and ([id]/page.tsx)')).toEqual([
      '(shop)/page.tsx',
      '[id]/page.tsx'
    ])
  })

  it('reassembles without overlapping spans', () => {
    const text = 'see /tmp/a.txt and /tmp/b.txt done'
    const spans = extractFilePathProseSpans(text)
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.startIndex).toBeGreaterThanOrEqual(spans[i - 1]!.endIndex)
    }
  })

  it.each([
    'upgraded to 1.2.3 today',
    'requires Node.js 20 or newer',
    'running 20.11.0 in CI',
    'took 4.5s to finish',
    'visit example.com for details',
    'just some prose with no path here'
  ])('finds nothing in %s', (text) => {
    expect(spanTexts(text)).toEqual([])
  })

  it('ignores a bare filename with no separator', () => {
    // The terminal detector matches these behind a hover existence probe; chat
    // has none, so an unbacked guess would render as a dead link.
    expect(spanTexts('Here you go: README.md')).toEqual([])
  })

  it('ignores an http URL', () => {
    expect(spanTexts('see https://example.com/docs/guide.md now')).toEqual([])
  })

  describe('bare domains', () => {
    // These clear the separator rule, so they need their own suppression.
    it.each([
      'see example.com/foo for details',
      'see docs.rs/serde for details',
      'see github.com/a/b for details',
      'see foo.local/share here',
      'see www.example.com/x.md here'
    ])('finds nothing in %s', (text) => {
      expect(spanTexts(text)).toEqual([])
    })

    it('still finds a dotfile directory path', () => {
      expect(spanTexts('edit .github/workflows/ci.yml now')).toContain('.github/workflows/ci.yml')
    })

    it('still finds a first segment with a numeric tail', () => {
      expect(spanTexts('wrote v1.2/out.ts today')).toContain('v1.2/out.ts')
    })

    it('still finds an explicitly relative path', () => {
      expect(spanTexts('open ./example.com/a.ts now')).toContain('./example.com/a.ts')
    })
  })

  it('skips a run longer than the scan cap', () => {
    expect(spanTexts(`${'a'.repeat(2100)} src/a.ts`)).toEqual([])
  })
})
