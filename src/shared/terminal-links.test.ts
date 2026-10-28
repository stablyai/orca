import { describe, expect, it } from 'vitest'
import {
  TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES,
  columnForTerminalFileLinkTap
} from './terminal-file-link-conformance'
import {
  extractTerminalFileLinks,
  findExactTerminalFileLink,
  isPathInsideWorktree,
  resolveTerminalFileLink,
  toWorktreeRelativePath
} from './terminal-links'

function extractTerminalFileLinkAtColumn(lineText: string, column: number) {
  return (
    extractTerminalFileLinks(lineText).find(
      (link) => column >= link.startIndex && column < link.endIndex
    ) ?? null
  )
}

describe('terminal path helpers', () => {
  describe('shared terminal file-link tap conformance', () => {
    it.each(TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES)('$name', (testCase) => {
      const link = extractTerminalFileLinkAtColumn(
        testCase.lineText,
        columnForTerminalFileLinkTap(testCase)
      )
      expect(
        link ? { pathText: link.pathText, line: link.line, column: link.column } : null
      ).toEqual(testCase.expected)
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
      const links = extractTerminalFileLinks('./src/file.ts is the entry point')
      expect(links.map((link) => link.displayText)).toEqual(['./src/file.ts'])
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

    it('detects an extensionless absolute path ending in a spaced segment', () => {
      const links = extractTerminalFileLinks('/Users/alice/My Folder')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '/Users/alice/My Folder',
        displayText: '/Users/alice/My Folder'
      })
    })

    it('does not treat mid-line command arguments as line-ending spaced paths', () => {
      const links = extractTerminalFileLinks('run /usr/bin/env node, then continue')
      expect(links.map((link) => link.pathText)).not.toContain('/usr/bin/env node')
    })

    it('does not linkify root-only or relative trailing separator tokens', () => {
      expect(extractTerminalFileLinks('progress 1 / 3')).toEqual([])
      expect(extractTerminalFileLinks('/')).toEqual([])
      expect(extractTerminalFileLinks('./')).toEqual([])
      expect(extractTerminalFileLinks('../')).toEqual([])
      expect(extractTerminalFileLinks('~/')).toEqual([])
      expect(extractTerminalFileLinks('C:\\')).toEqual([])
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

  it('keeps line and column suffixes from exact OSC hyperlink text', () => {
    expect(findExactTerminalFileLink('docs/README.md:12:3')).toMatchObject({
      pathText: 'docs/README.md',
      line: 12,
      column: 3
    })
  })

  it('does not take partial text as an OSC hyperlink target', () => {
    expect(findExactTerminalFileLink('open docs/README.md')).toBeNull()
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
