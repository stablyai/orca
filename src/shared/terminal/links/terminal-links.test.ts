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

    it('does not linkify root-only or relative trailing separator tokens', () => {
      expect(extractTerminalFileLinks('progress 1 / 3')).toEqual([])
      expect(extractTerminalFileLinks('/')).toEqual([])
      expect(extractTerminalFileLinks('./')).toEqual([])
      expect(extractTerminalFileLinks('../')).toEqual([])
      expect(extractTerminalFileLinks('~/')).toEqual([])
      expect(extractTerminalFileLinks('C:\\')).toEqual([])
    })

    // A spaced guess must never hide the plain path; the host keeps whichever exists.

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

  it.each([
    ['D:/tmp/test.md#L11', true, 'D:/tmp/test.md', 11, null],
    ['D:/tmp/test.md#L11-13', true, 'D:/tmp/test.md', 11, null],
    ['D:/tmp/test.md#L11-L13', true, 'D:/tmp/test.md', 11, null],
    ['D:/tmp/notes#1.md', true, 'D:/tmp/notes#1.md', null, null],
    ['/tmp/test.md#L11', false, '/tmp/test.md', 11, null],
    ['/tmp/test.md#L11C4-L13', false, '/tmp/test.md', 11, 4],
    ['docs/notes#1.md', false, 'docs/notes#1.md', null, null]
  ])(
    'reads a line fragment on OSC hyperlink path %s',
    (target, windowsPathsFirst, pathText, line, column) => {
      const osc = classifyTerminalOscLinkTarget(target, { windowsPathsFirst, allowUncHost: false })
      expect(osc).toMatchObject({ kind: 'path', link: { pathText, line, column } })
    }
  )

  it.each(['file:///D:/tmp/test.md#L11-L13', 'file:///D:/tmp/test.md#L11-13'])(
    'reads the start line of file URL line-range fragment %s',
    (target) => {
      const osc = classifyTerminalOscLinkTarget(target, {
        windowsPathsFirst: true,
        allowUncHost: false
      })
      expect(osc).toMatchObject({
        kind: 'file-url',
        target: { filePath: 'D:/tmp/test.md', line: 11 }
      })
    }
  )

  it('does not read a malformed URL OSC hyperlink target as a path', () => {
    const osc = classifyTerminalOscLinkTarget('https://exa mple.com', {
      windowsPathsFirst: false,
      allowUncHost: false
    })
    expect(osc).toBeNull()
  })

  describe('plain-text file:// URIs', () => {
    it('does not also emit a bare-path link for the URI body', () => {
      const links = extractTerminalFileLinks('file:///Users/dev/orca/report.html')
      expect(links.map((link) => link.displayText)).toEqual(['file:///Users/dev/orca/report.html'])
    })
  })
})
