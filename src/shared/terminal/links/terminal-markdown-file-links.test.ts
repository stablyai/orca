import { describe, expect, it } from 'vitest'
import { extractTerminalFileLinks } from './terminal-links'

describe('extractTerminalFileLinks', () => {
  it('preserves bare percent filenames and route punctuation beside Markdown', () => {
    expect(
      extractTerminalFileLinks(
        '/tmp/literal%20/file.pdf [PDF](/tmp/report.pdf) app/(shop)/[id]/page.tsx'
      ).map((link) => link.pathText)
    ).toEqual(['/tmp/literal%20/file.pdf', '/tmp/report.pdf', 'app/(shop)/[id]/page.tsx'])
  })

  it('does not turn an external link label into a local file target', () => {
    expect(
      extractTerminalFileLinks('[/tmp/misleading.pdf](https://example.com/report.pdf)')
    ).toEqual([])
  })

  it('preserves adjacent route bracket and parenthesis segments in bare paths', () => {
    expect(
      extractTerminalFileLinks('/tmp/[id](group)/page.tsx').map((link) => link.pathText)
    ).toEqual(['/tmp/[id](group)/page.tsx'])
  })

  it('finds adjacent Markdown destinations independently', () => {
    expect(
      extractTerminalFileLinks('[one](/tmp/one.pdf)[two](/tmp/two.pdf)').map(
        (link) => link.pathText
      )
    ).toEqual(['/tmp/one.pdf', '/tmp/two.pdf'])
  })
})
