import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { joinAbsolutePath, normalizeAbsolutePath } from '../../lib/terminal-path-normalization'
import {
  extractTerminalFileLinkCandidates,
  resolveTerminalFileLink
} from '../../lib/terminal-links'
import {
  buildHardWrappedPathLogicalLineCandidates,
  rangeForParsedFileLink
} from './wrapped-terminal-link-ranges'

describe('parenthesized hard-wrapped terminal file targets', () => {
  it.each([
    '(/tmp/产物/file.md)',
    '文档 (/tmp/产物/file.md)',
    '文档 (/tmp/产物/file(版).md)',
    '文档(/tmp/产物/file.md)',
    'label(/tmp/产物/file.md)',
    '文档:(/tmp/产物/file.md)',
    '文档/链接:(/tmp/产物/file.md)',
    'docs/guide.md:(/tmp/产物/file.md)',
    'docs/guide.md(/tmp/产物/file.md)',
    '文档(/tmp/产物/file(版).md)',
    '文档(./产物/file.md)',
    '文档(~/产物/file.md)',
    String.raw`文档(C:\产物\file.md)`
  ])('does not append an unrelated filename after a closed wrapper in %s', async (firstRow) => {
    const terminal = new Terminal({ cols: 180, rows: 4, allowProposedApi: true })
    try {
      await new Promise<void>((resolve) => terminal.write(`${firstRow}\r\n  next.md`, resolve))
      for (const row of [1, 2]) {
        expect(
          buildHardWrappedPathLogicalLineCandidates(terminal.buffer.active, row).some(
            (logical) => logical.rows.length > 1 && logical.text.includes('next.md')
          )
        ).toBe(false)
      }
    } finally {
      terminal.dispose()
    }
  })

  it.each([
    ['/tmp/产物/notes(1)', '/tmp/产物/notes(1).md'],
    ['/tmp/目录(一/二)', '/tmp/目录(一/二).md'],
    ['C:/产物/notes(1)', 'C:/产物/notes(1).md'],
    [String.raw`C:\产物\notes(1)`, String.raw`C:\产物\notes(1).md`]
  ])('keeps literal path parentheses across rows in %s', async (firstRow, target) => {
    const terminal = new Terminal({ cols: 180, rows: 4, allowProposedApi: true })
    try {
      await new Promise<void>((resolve) => terminal.write(`${firstRow}\r\n  .md`, resolve))
      for (const row of [1, 2]) {
        const paths = buildHardWrappedPathLogicalLineCandidates(terminal.buffer.active, row)
          .flatMap((logical) => extractTerminalFileLinkCandidates(logical.text))
          .map((parsed) => parsed.pathText)
        expect(paths).toContain(target)
      }
    } finally {
      terminal.dispose()
    }
  })

  it('reconstructs an unclosed path wrapper directly after a label', async () => {
    const terminal = new Terminal({ cols: 180, rows: 4, allowProposedApi: true })
    try {
      await new Promise<void>((resolve) =>
        terminal.write('文档(/tmp/产物/final-\r\n  排版.html)', resolve)
      )
      for (const row of [1, 2]) {
        const matches = buildHardWrappedPathLogicalLineCandidates(terminal.buffer.active, row)
          .flatMap((logical) =>
            extractTerminalFileLinkCandidates(logical.text).map((parsed) => ({ logical, parsed }))
          )
          .filter(({ parsed }) => parsed.pathText === '/tmp/产物/final-排版.html')
        expect(matches).not.toHaveLength(0)
        const { logical, parsed } = matches[0]
        expect(rangeForParsedFileLink(logical, parsed.startIndex, parsed.endIndex)).toEqual({
          start: { x: 6, y: 1 },
          end: { x: 11, y: 2 }
        })
      }
    } finally {
      terminal.dispose()
    }
  })

  it.each([
    '/tmp/产物/final-排版(olive-journal).html',
    'C:/产物/final-排版.html',
    String.raw`C:\产物\final-排版.html`,
    './产物/final-排版.html',
    '~/产物/final-排版.html',
    '/tmp/产物/final-𠮷.html',
    '/tmp/cafe\u0301/final-article.html',
    '/tmp/ascii/final-article.html'
  ])(
    'reconstructs %s from either row without including the label or closing wrapper',
    async (target) => {
      const split = target.indexOf('final-') + 'final-'.length
      const terminal = new Terminal({ cols: 180, rows: 4, allowProposedApi: true })
      try {
        await new Promise<void>((resolve) =>
          terminal.write(
            `README.md · 预览 (${target.slice(0, split)}\r\n  ${target.slice(split)})`,
            resolve
          )
        )
        const first = terminal.buffer.active.getLine(0)!
        const second = terminal.buffer.active.getLine(1)!
        expect(first.isWrapped).toBe(false)
        expect(second.isWrapped).toBe(false)
        const openingColumn = Array.from({ length: terminal.cols }, (_, index) => index).find(
          (index) => first.getCell(index)?.getChars() === '('
        )!
        let closingColumn = 0
        for (let column = 0; column < terminal.cols; column++) {
          if (second.getCell(column)?.getChars() === ')') {
            closingColumn = column
          }
        }
        for (const row of [1, 2]) {
          const matches = buildHardWrappedPathLogicalLineCandidates(terminal.buffer.active, row)
            .flatMap((logical) =>
              extractTerminalFileLinkCandidates(logical.text).map((parsed) => ({
                logical,
                parsed
              }))
            )
            .filter(({ parsed }) => parsed.pathText === target)
          expect(matches).not.toHaveLength(0)
          const { logical, parsed } = matches[0]
          expect(resolveTerminalFileLink(parsed, '/workspace', '/home/user')).toEqual({
            absolutePath: target.startsWith('~')
              ? joinAbsolutePath('/home/user', target.slice(2))
              : target.startsWith('./')
                ? joinAbsolutePath('/workspace', target)
                : normalizeAbsolutePath(target)?.normalized,
            line: null,
            column: null
          })
          expect(rangeForParsedFileLink(logical, parsed.startIndex, parsed.endIndex)).toEqual({
            start: { x: openingColumn + 2, y: 1 },
            end: { x: closingColumn, y: 2 }
          })
        }
      } finally {
        terminal.dispose()
      }
    }
  )
})
