import { describe, expect, it } from 'vitest'
import { extractTerminalFileLinkCandidates, extractTerminalFileLinks } from './terminal-links'

for (const extract of [extractTerminalFileLinks, extractTerminalFileLinkCandidates]) {
  describe(extract.name, () => {
    it.each([
      [
        '[/tmp/Каталог/отчет.pdf](/tmp/Каталог/отчет.pdf)',
        '/tmp/Каталог/отчет.pdf',
        '/tmp/Каталог/отчет.pdf'
      ],
      ['[/wrong/file.pdf](/tmp/right.pdf)', '/tmp/right.pdf', '/tmp/right.pdf'],
      [
        '[PDF](/tmp/folder%20with%20spaces/report.pdf)',
        '/tmp/folder%20with%20spaces/report.pdf',
        '/tmp/folder with spaces/report.pdf'
      ],
      [
        '[PDF](/tmp/literal%2520/report.pdf)',
        '/tmp/literal%2520/report.pdf',
        '/tmp/literal%20/report.pdf'
      ],
      [
        '[PDF](</tmp/folder with spaces/report.pdf>)',
        '/tmp/folder with spaces/report.pdf',
        '/tmp/folder with spaces/report.pdf'
      ],
      [
        '[route](app/(shop)/products/[id]/page.tsx:12:3 "source")',
        'app/(shop)/products/[id]/page.tsx:12:3',
        'app/(shop)/products/[id]/page.tsx'
      ],
      [
        '[route](/tmp/report\\(final\\).pdf)',
        '/tmp/report\\(final\\).pdf',
        '/tmp/report(final).pdf'
      ],
      [
        '[file](file:///tmp/folder%20name/report.pdf#L12C3)',
        'file:///tmp/folder%20name/report.pdf#L12C3',
        '/tmp/folder name/report.pdf'
      ],
      [
        '[source](C:\\repo\\src\\file.ts:12:3)',
        'C:\\repo\\src\\file.ts:12:3',
        'C:\\repo\\src\\file.ts'
      ],
      [
        '[cfg](C:\\Users\\me\\.config\\app.json)',
        'C:\\Users\\me\\.config\\app.json',
        'C:\\Users\\me\\.config\\app.json'
      ],
      ['[ci](src\\.github\\ci.yml)', 'src\\.github\\ci.yml', 'src\\.github\\ci.yml'],
      ['[source](README.md:12:3)', 'README.md:12:3', 'README.md'],
      ['[PDF](/tmp/100%/report.pdf)', '/tmp/100%/report.pdf', '/tmp/100%/report.pdf']
    ])('extracts only destination from %s', (text, displayText, pathText) => {
      const links = extract(`before ${text} after`)
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ pathText, displayText })
      expect(`before ${text} after`.slice(links[0].startIndex, links[0].endIndex)).toBe(displayText)
      if (text.includes(':12:3') || text.includes('#L12C3')) {
        expect(links[0]).toMatchObject({ line: 12, column: 3 })
      }
    })

    it('preserves bare percent filenames and route punctuation beside Markdown', () => {
      expect(
        extract('/tmp/literal%20/file.pdf [PDF](/tmp/report.pdf) app/(shop)/[id]/page.tsx').map(
          (link) => link.pathText
        )
      ).toEqual(['/tmp/literal%20/file.pdf', '/tmp/report.pdf', 'app/(shop)/[id]/page.tsx'])
    })

    it('does not turn an external link label into a local file target', () => {
      expect(extract('[/tmp/misleading.pdf](https://example.com/report.pdf)')).toEqual([])
    })

    it('preserves adjacent route bracket and parenthesis segments in bare paths', () => {
      expect(extract('/tmp/[id](group)/page.tsx').map((link) => link.pathText)).toEqual([
        '/tmp/[id](group)/page.tsx'
      ])
    })

    it('finds adjacent Markdown destinations independently', () => {
      expect(
        extract('[one](/tmp/one.pdf)[two](/tmp/two.pdf)').map((link) => link.pathText)
      ).toEqual(['/tmp/one.pdf', '/tmp/two.pdf'])
    })
  })
}
