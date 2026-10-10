import { describe, expect, it } from 'vitest'
import { extractTerminalFileLinks, resolveTerminalFileLink } from './terminal-links'

describe('Unicode bare terminal filenames', () => {
  it.each([
    '精读-阻塞清单.md',
    '𠮷.md',
    'café.md',
    'cafe\u0301.md',
    '보고서.md',
    'تقرير.md',
    'रिपोर्ट.md',
    '报告１２.md'
  ])('detects %s without a path separator', (filename) => {
    const text = `可勾选清单 (${filename}) · README.md`
    const links = extractTerminalFileLinks(text)
    expect(links.map((link) => link.pathText)).toEqual([filename, 'README.md'])
    expect(links[0]).toMatchObject({
      startIndex: text.indexOf(filename),
      endIndex: text.indexOf(filename) + filename.length
    })
    expect(resolveTerminalFileLink(links[0], '/workspace')?.absolutePath).toBe(
      `/workspace/${filename}`
    )
  })

  it('preserves line and column suffixes', () => {
    const links = extractTerminalFileLinks('报告.md:12:3')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ pathText: '报告.md', line: 12, column: 3 })
    expect(resolveTerminalFileLink(links[0], 'C:\\repo')).toEqual({
      absolutePath: 'C:/repo/报告.md',
      line: 12,
      column: 3
    })
  })

  it('does not emit a duplicate basename from a separator path', () => {
    expect(extractTerminalFileLinks('./报告.md').map((link) => link.pathText)).toEqual([
      './报告.md'
    ])
  })

  it.each([
    '中文 𠮷 café',
    '１２٣ 42',
    '-报告.md --报告.md',
    '.报告.md',
    '\u0301报告.md',
    '报告.md，继续',
    'https://example.com/报告.md'
  ])('keeps conservative filename boundaries in %s', (text) => {
    expect(extractTerminalFileLinks(text)).toEqual([])
  })
})
