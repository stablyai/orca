import { describe, expect, it } from 'vitest'
import {
  extractTerminalFileLinkReadings,
  extractTerminalFileLinks,
  resolveTerminalFileLink
} from './terminal-links'

describe('CJK terminal path names', () => {
  it.each([
    '/tmp/前・後/a.txt',
    'C:/tmp/前･後/a.txt',
    String.raw`C:\tmp\前〜後\a.txt`,
    '//nas/base/前～後/a.txt',
    String.raw`\\nas\base\前・後\a.txt`,
    './前･後/a.txt',
    '/tmp/前〜後/space name/a.txt'
  ])('keeps punctuation inside %s', (filePath) => {
    const { links, guesses } = extractTerminalFileLinkReadings(filePath)
    expect([...links, ...guesses].find((link) => link.pathText === filePath)).toMatchObject({
      startIndex: 0,
      endIndex: filePath.length
    })
  })

  it('preserves the location and normalized Windows target', () => {
    const [link] = extractTerminalFileLinks(String.raw`C:\tmp\前～後\a.txt:12:3`)
    expect(link && resolveTerminalFileLink(link, '/cwd')).toEqual({
      absolutePath: 'C:/tmp/前～後/a.txt',
      line: 12,
      column: 3
    })
  })

  it.each([',', ';', '"', "'", '，', '。'])('stops a file path at %s', (delimiter) => {
    expect(
      extractTerminalFileLinks(`/tmp/前・後/a.txt${delimiter}次`).map((link) => link.pathText)
    ).toEqual(['/tmp/前・後/a.txt'])
  })

  it('keeps file and web URI handling separate', () => {
    expect(extractTerminalFileLinks('https://example.com/前･後/a.txt')).toEqual([])
    expect(extractTerminalFileLinks('file:///tmp/前･後/a.txt')[0]?.pathText).toBe(
      '/tmp/前･後/a.txt'
    )
  })
})
