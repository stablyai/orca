import { describe, expect, it } from 'vitest'
import {
  TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES,
  columnForTerminalFileLinkTap
} from './terminal-file-link-conformance'
import { classifyTerminalOscLinkTarget } from './terminal-osc-link-target'
import {
  extractTerminalFileLinkReadings,
  extractTerminalFileLinks,
  isPathInsideWorktree,
  resolveTerminalFileLink,
  toWorktreeRelativePath
} from './terminal-links'

// Every reading a host that checks files is offered.
function allReadings(lineText: string) {
  const { links, guesses } = extractTerminalFileLinkReadings(lineText)
  return [...links, ...guesses]
}

function readingsAt(lineText: string, column: number) {
  return allReadings(lineText)
    .filter((link) => column >= link.startIndex && column < link.endIndex)
    .map(({ pathText, line, column }) => ({ pathText, line, column }))
}

function pathTexts(lineText: string): string[] {
  return allReadings(lineText).map((link) => link.pathText)
}

describe('terminal path helpers', () => {
  describe('shared terminal file-link tap conformance', () => {
    // Desktop offers every reading at the tap and lets the host's existence check choose.
    it.each(TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES)('$name', (testCase) => {
      const readings = readingsAt(testCase.lineText, columnForTerminalFileLinkTap(testCase))
      if (testCase.expected) {
        expect(readings).toContainEqual(testCase.expected)
      } else {
        expect(readings).toEqual([])
      }
    })
  })

  it('keeps worktree-relative paths for forward-slash Windows UNC paths', () => {
    expect(isPathInsideWorktree('//server/share/repo/src/file.ts', '\\\\server\\share\\repo')).toBe(
      true
    )
    expect(
      toWorktreeRelativePath('//server/share/repo/src/file.ts', '\\\\server\\share\\repo')
    ).toBe('src/file.ts')

    expect(isPathInsideWorktree('//server/share/repo/src/file.ts', '//Server/Share/Repo')).toBe(
      true
    )
    expect(toWorktreeRelativePath('//server/share/repo/src/file.ts', '//Server/Share/Repo')).toBe(
      'src/file.ts'
    )
  })

  describe('extractTerminalFileLinks bare-filename tokens', () => {
    it('does not treat regular URL hosts as local file paths', () => {
      expect(
        extractTerminalFileLinks(
          'PR opened: https://github.com/stablyai/orca-marketing-website/pull/82'
        )
      ).toEqual([])
    })

    it('does not double-link bare tokens that are part of an already-matched path', () => {
      const paths = pathTexts('./src/file.ts is the entry point')
      expect(paths).toContain('./src/file.ts')
      expect(paths).not.toContain('file.ts')
    })
  })

  describe('extractTerminalFileLinks local path tokens', () => {
    it('keeps Unicode path segments in the detected range', () => {
      expect(extractTerminalFileLinks('/tmp/报告.html').map((link) => link.displayText)).toEqual([
        '/tmp/报告.html'
      ])
      expect(
        extractTerminalFileLinks('docs/café/report.pdf').map((link) => link.displayText)
      ).toEqual(['docs/café/report.pdf'])
    })

    it('offers absolute paths with spaces before the filename', () => {
      expect(pathTexts('/Users/Path/FolderName with Space/content.js')).toContain(
        '/Users/Path/FolderName with Space/content.js'
      )
    })

    it('offers an extensionless absolute path ending in a spaced segment', () => {
      expect(pathTexts('/Users/alice/My Folder')).toContain('/Users/alice/My Folder')
    })

    it('does not linkify root-only or relative trailing separator tokens', () => {
      expect(extractTerminalFileLinks('progress 1 / 3')).toEqual([])
      expect(extractTerminalFileLinks('/')).toEqual([])
      expect(extractTerminalFileLinks('./')).toEqual([])
      expect(extractTerminalFileLinks('../')).toEqual([])
      expect(extractTerminalFileLinks('~/')).toEqual([])
      expect(extractTerminalFileLinks('C:\\')).toEqual([])
    })

    it('offers an extensionless relative path ending in a spaced segment', () => {
      expect(pathTexts('./My Folder')).toContain('./My Folder')
    })

    // A spaced guess must never hide the plain path; the host keeps whichever exists.
    it.each([
      [
        '~/orca-lanes/webhooks-research/bots/bots-ux-outline.md. It covers setup and/or teardown.',
        '~/orca-lanes/webhooks-research/bots/bots-ux-outline.md'
      ],
      ['Wrote ~/notes/plan.md. Next: src/foo.ts', '~/notes/plan.md'],
      ['Wrote ~/notes/plan.md and src/foo.ts covers the rest', '~/notes/plan.md'],
      ['See /Users/me/a/b.md. Then C:\\Users\\me\\x.md.', '/Users/me/a/b.md'],
      ['See /home/me/x.md. Then the pane/tab work.', '/home/me/x.md'],
      ['See C:\\Users\\me\\x.md. Then the pane/tab work.', 'C:\\Users\\me\\x.md']
    ])('offers the plain path in %j', (line, path) => {
      expect(pathTexts(line)).toContain(path)
    })

    it.each([
      '/Users/a/C# Projects/x.cs',
      '/Users/a/Tom & Jerry/x.ts',
      '/Users/a/Notes - Draft/x.md',
      'C:\\Users\\Me\\Q&A Docs\\x.txt',
      '/tmp/Foo.bar Docs/report.md',
      '/tmp/My File.123',
      'docs/My Archive.7z',
      'docs/My 檔案.文件'
    ])('offers spaced folder names with symbols: %s', (path) => {
      expect(pathTexts(`open ${path}, then continue`)).toContain(path)
    })

    it('still offers the spaced reading so an existing spaced path can win', () => {
      expect(pathTexts('Saved /Users/me/My Docs/plan.md. Next: src/foo.ts')).toEqual(
        expect.arrayContaining(['/Users/me/My', '/Users/me/My Docs/plan.md'])
      )
    })

    it('detects framework route paths with bracket and paren segments', () => {
      const links = extractTerminalFileLinks(
        'Error in app/(shop)/products/[productId]/page.tsx:42:7'
      )
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: 'app/(shop)/products/[productId]/page.tsx',
        line: 42,
        column: 7,
        displayText: 'app/(shop)/products/[productId]/page.tsx:42:7'
      })
    })

    it('handles large spaced path lists in linear time', () => {
      const line = Array.from({ length: 20_000 }, () => '/tmp/Foo Bar/file').join(', ')

      const paths = pathTexts(line)

      expect(paths.filter((path) => path === '/tmp/Foo Bar/file')).toHaveLength(20_000)
    })

    it('grows a spaced reading over a bounded number of words', () => {
      const paths = pathTexts(`/tmp/root ${'part/x '.repeat(20_000)}`)

      expect(paths.filter((path) => path.startsWith('/tmp/root'))).toHaveLength(11)
    })
  })

  it('resolves tilde-prefixed paths against explicit terminal home when cwd is outside home', () => {
    expect(
      resolveTerminalFileLink(
        {
          pathText: '~/Documents/Path/file_name',
          line: null,
          column: null,
          startIndex: 0,
          endIndex: 26,
          displayText: '~/Documents/Path/file_name'
        },
        '/workspace/project',
        '/home/alice'
      )
    ).toEqual({
      absolutePath: '/home/alice/Documents/Path/file_name',
      line: null,
      column: null
    })
  })

  it('keeps a path spanning prose apart from the paths written in it', () => {
    const { links, guesses } = extractTerminalFileLinkReadings(
      '● Wrote ~/x/notes.md. It covers setup and/or teardown.'
    )
    expect(links.map((link) => link.pathText)).toEqual(['~/x/notes.md', 'and/or'])
    expect(guesses.map((link) => link.pathText)).toContain('~/x/notes.md. It covers setup')
  })

  it.each([
    ['docs/README.md:12:3', 'docs/README.md', 12],
    ['/Users/a/My  Folder/file.ts:3', '/Users/a/My  Folder/file.ts', 3],
    ['docs/My  Folder/file.ts', 'docs/My  Folder/file.ts', null]
  ])('takes OSC hyperlink target %s as written', (target, pathText, line) => {
    const osc = classifyTerminalOscLinkTarget(target, {
      windowsPathsFirst: false,
      allowUncHost: false
    })
    expect(osc).toMatchObject({ kind: 'path', link: { pathText, line } })
  })

  it('does not read a malformed URL OSC hyperlink target as a path', () => {
    const osc = classifyTerminalOscLinkTarget('https://exa mple.com', {
      windowsPathsFirst: false,
      allowUncHost: false
    })
    expect(osc).toBeNull()
  })

  describe('plain-text file:// URIs', () => {
    it('extracts a printed file:// URI as a file link resolving to its path', () => {
      const line = 'Report: file:///Users/dev/orca/report.html'
      const link = extractTerminalFileLinks(line).find(
        (candidate) => candidate.displayText === 'file:///Users/dev/orca/report.html'
      )
      expect(link).toMatchObject({ pathText: '/Users/dev/orca/report.html' })
      expect(resolveTerminalFileLink(link!, '/Users/dev/orca')).toEqual({
        absolutePath: '/Users/dev/orca/report.html',
        line: null,
        column: null
      })
    })

    it('does not also emit a bare-path link for the URI body', () => {
      const links = extractTerminalFileLinks('file:///Users/dev/orca/report.html')
      expect(links.map((link) => link.displayText)).toEqual(['file:///Users/dev/orca/report.html'])
    })
  })
})
