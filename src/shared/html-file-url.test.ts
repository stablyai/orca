import { describe, expect, it } from 'vitest'
import { htmlFilePathFromUrl } from './html-file-url'

describe('htmlFilePathFromUrl', () => {
  it.each([
    ['file:///Users/me/report.html', '/Users/me/report.html'],
    ['file://localhost/home/me/report.htm', '/home/me/report.htm'],
    ['FILE:///C:/My%20Reports/%E4%B8%AD.HTM', 'C:/My Reports/中.HTM'],
    ['file:///home/me/percent%2520.html', '/home/me/percent%20.html']
  ])('decodes %s', (input, expected) => {
    expect(htmlFilePathFromUrl(input)).toBe(expected)
  })

  it.each([
    'file://build-server/home/me/report.html',
    'file:////build-server/share/report.html',
    'file:///tmp%2freport.html',
    'file:///tmp/%5creport.html',
    'file:///tmp/re\nport.html',
    'file:///tmp/%E0%A4%A.html',
    'file:///tmp/%00report.html',
    'file:///tmp/report%0a.html',
    'file:///tmp/report.html?secret=1',
    'file:///tmp/report.html#section',
    'file:///tmp/report.html?',
    'file:///tmp/report.html#',
    'file:///tmp/source.ts',
    'file:report.html',
    'https://example.com/report.html',
    './report.html'
  ])('refuses unsupported or malformed input %s', (input) => {
    expect(htmlFilePathFromUrl(input)).toBeNull()
  })
})
