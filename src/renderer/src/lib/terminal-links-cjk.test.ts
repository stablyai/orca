import { describe, expect, it } from 'vitest'
import { extractTerminalFileLinks, resolveTerminalFileLinkText } from './terminal-links'

describe('CJK terminal path names', () => {
  for (const character of ['・', '･', '〜', '～']) {
    it.each([
      '/tmp/前CHAR後/a.txt',
      'C:/tmp/前CHAR後/a.txt',
      String.raw`C:\tmp\前CHAR後\a.txt`,
      '//nas/base/前CHAR後/a.txt',
      String.raw`\\nas\base\前CHAR後\a.txt`,
      './前CHAR後/a.txt',
      '/tmp/前CHAR後/space name/a.txt'
    ])(`keeps ${character} in %s`, (template) => {
      const filePath = template.replace('CHAR', character)
      const links = extractTerminalFileLinks(filePath)
      expect(links.map((link) => link.pathText)).toEqual([filePath])
      expect(links[0]).toMatchObject({ startIndex: 0, endIndex: filePath.length })
    })

    it(`preserves location and normalized Windows target for ${character}`, () => {
      expect(resolveTerminalFileLinkText(`C:\\tmp\\前${character}後\\a.txt:12:3`, '/cwd')).toEqual({
        absolutePath: `C:/tmp/前${character}後/a.txt`,
        line: 12,
        column: 3
      })
    })

    it.each([',', ';', '"', "'", '，', '。'])(`stops ${character} paths at %s`, (delimiter) => {
      const filePath = `/tmp/前${character}後/a.txt`
      expect(
        extractTerminalFileLinks(`${filePath}${delimiter}次`).map((link) => link.pathText)
      ).toEqual([filePath])
    })

    it(`keeps URI handling separate for ${character}`, () => {
      expect(extractTerminalFileLinks(`https://example.com/前${character}後/a.txt`)).toEqual([])
      expect(extractTerminalFileLinks(`file:///tmp/前${character}後/a.txt`)[0]?.pathText).toBe(
        `/tmp/前${character}後/a.txt`
      )
    })
  }
})
