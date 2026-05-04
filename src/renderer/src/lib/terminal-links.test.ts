import { describe, expect, it } from 'vitest'
import {
  extractTerminalFileLinks,
  isPathInsideWorktree,
  resolveTerminalFileLink,
  toWorktreeRelativePath
} from './terminal-links'

describe('terminal path helpers', () => {
  it('keeps worktree-relative paths on Windows external files', () => {
    expect(isPathInsideWorktree('C:\\repo\\src\\file.ts', 'C:\\repo')).toBe(true)
    expect(toWorktreeRelativePath('C:\\repo\\src\\file.ts', 'C:\\repo')).toBe('src/file.ts')
  })

  describe('extractTerminalFileLinks bare-filename tokens', () => {
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
})
