import { describe, expect, it } from 'vitest'
import {
  extractTerminalFileLinks,
  isPathInsideWorktree,
  resolveTerminalFileLink,
  resolveTerminalFileLinkText,
  toWorktreeRelativePath
} from './terminal-links'

describe('terminal path helpers', () => {
  it('keeps worktree-relative paths on Windows external files', () => {
    expect(isPathInsideWorktree('C:\\repo\\src\\file.ts', 'C:\\repo')).toBe(true)
    expect(toWorktreeRelativePath('C:\\repo\\src\\file.ts', 'C:\\repo')).toBe('src/file.ts')
  })

  it('keeps worktree-relative paths for forward-slash Windows UNC paths', () => {
    expect(isPathInsideWorktree('//server/share/repo/src/file.ts', '\\\\server\\share\\repo')).toBe(
      true
    )
    expect(
      toWorktreeRelativePath('//server/share/repo/src/file.ts', '\\\\server\\share\\repo')
    ).toBe('src/file.ts')
  })

  describe('extractTerminalFileLinks bare-filename tokens', () => {
    it('does not treat regular URL hosts as local file paths', () => {
      expect(
        extractTerminalFileLinks(
          'PR opened: https://github.com/stablyai/orca-marketing-website/pull/82'
        )
      ).toEqual([])
    })

    it('emits tentative link candidates for each token in ls-style output', () => {
      const line = 'CLAUDE.md    package.json    pnpm-lock.yaml    README.md'
      const links = extractTerminalFileLinks(line)
      const texts = links.map((link) => link.displayText)
      expect(texts).toEqual(['CLAUDE.md', 'package.json', 'pnpm-lock.yaml', 'README.md'])
      const claudeMd = links[0]
      expect(line.slice(claudeMd.startIndex, claudeMd.endIndex)).toBe('CLAUDE.md')
    })

    it('recognises common extensionless project files (Makefile, LICENSE, …)', () => {
      const links = extractTerminalFileLinks('Makefile LICENSE README Dockerfile src tests')
      expect(links.map((link) => link.displayText).sort()).toEqual([
        'Dockerfile',
        'LICENSE',
        'Makefile',
        'README'
      ])
    })

    it('ignores pure numbers, flag-looking tokens, and dotfile-only strings', () => {
      expect(extractTerminalFileLinks('42 100 .. . -v --verbose src dist')).toEqual([])
    })

    it('still strips trailing punctuation from bare filenames', () => {
      const links = extractTerminalFileLinks('See package.json, pnpm-lock.yaml.')
      expect(links.map((link) => link.displayText)).toEqual(['package.json', 'pnpm-lock.yaml'])
    })

    it('does not double-link bare tokens that are part of an already-matched path', () => {
      const links = extractTerminalFileLinks('./src/file.ts is the entry point')
      expect(links.map((link) => link.displayText)).toEqual(['./src/file.ts'])
    })

    it('carries line:column suffix on bare filenames (e.g. stack-trace output)', () => {
      const links = extractTerminalFileLinks('foo.ts:12:3 failed')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ pathText: 'foo.ts', line: 12, column: 3 })
    })
  })

  describe('extractTerminalFileLinks local path tokens', () => {
    it('detects tilde-prefixed POSIX paths', () => {
      const links = extractTerminalFileLinks('~/Documents/Path/file_name')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '~/Documents/Path/file_name',
        displayText: '~/Documents/Path/file_name'
      })
    })

    it('detects absolute paths with spaces before the filename', () => {
      const links = extractTerminalFileLinks('/Users/Path/FolderName with Space/content.js')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '/Users/Path/FolderName with Space/content.js',
        displayText: '/Users/Path/FolderName with Space/content.js'
      })
    })

    it('stops a spaced absolute path before trailing prose', () => {
      const links = extractTerminalFileLinks(
        'Open /Users/Path/FolderName with Space/content.js for details'
      )
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '/Users/Path/FolderName with Space/content.js',
        displayText: '/Users/Path/FolderName with Space/content.js'
      })
    })

    it('detects an extensionless absolute path ending in a spaced segment', () => {
      const links = extractTerminalFileLinks('/Users/alice/My Folder')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '/Users/alice/My Folder',
        displayText: '/Users/alice/My Folder'
      })
    })

    it('detects an extensionless relative path ending in a spaced segment', () => {
      const links = extractTerminalFileLinks('./My Folder')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: './My Folder',
        displayText: './My Folder'
      })
    })

    it('handles large spaced path lists without quadratic overlap scans', () => {
      const line = Array.from({ length: 20_000 }, () => '/tmp/Foo Bar/file').join(', ')

      const links = extractTerminalFileLinks(line)

      expect(links).toHaveLength(20_000)
      expect(links[0].pathText).toBe('/tmp/Foo Bar/file')
    }, 5_000)
  })

  it('supports Windows cwd resolution for terminal file links', () => {
    expect(
      resolveTerminalFileLink(
        {
          pathText: '.\\src\\file.ts',
          line: 12,
          column: 3,
          startIndex: 0,
          endIndex: 13,
          displayText: '.\\src\\file.ts:12:3'
        },
        'C:\\repo'
      )
    ).toEqual({
      absolutePath: 'C:/repo/src/file.ts',
      line: 12,
      column: 3
    })
  })

  it('resolves tilde-prefixed POSIX paths against the cwd user home', () => {
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
        '/Users/alice/project'
      )
    ).toEqual({
      absolutePath: '/Users/alice/Documents/Path/file_name',
      line: null,
      column: null
    })
  })

  it('resolves tilde-prefixed Windows paths against the cwd user home', () => {
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
        'C:\\Users\\Alice\\project'
      )
    ).toEqual({
      absolutePath: 'C:/Users/Alice/Documents/Path/file_name',
      line: null,
      column: null
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

  it('resolves exact repo-relative OSC hyperlink text', () => {
    expect(resolveTerminalFileLinkText('docs/README.md', '/repo')).toEqual({
      absolutePath: '/repo/docs/README.md',
      line: null,
      column: null
    })
  })

  it('keeps line and column suffixes from exact OSC hyperlink text', () => {
    expect(resolveTerminalFileLinkText('docs/README.md:12:3', '/repo')).toEqual({
      absolutePath: '/repo/docs/README.md',
      line: 12,
      column: 3
    })
  })

  it('does not resolve partial text as an OSC hyperlink target', () => {
    expect(resolveTerminalFileLinkText('open docs/README.md', '/repo')).toBeNull()
  })
})
