import { performance } from 'node:perf_hooks'
import { describe, it, expect } from 'vitest'
import { extractTerminalFileLinks, extractTerminalFileLinkCandidates } from './terminal-links'

// Regression guard for #5970: a full-screen TUI (e.g. ngrok run through Windows
// ConPTY) emits its dashboard as one newline-free line that is mostly alignment
// spaces with a few separators. Keep these non-matching inputs large enough to
// catch overlapping whitespace backtracking without making normal CI noisy.
describe('terminal-links ReDoS guard (#5970)', () => {
  const cases: [string, string][] = [
    ['separator + space padding', `a/${' '.repeat(30_000)}`],
    ['advertised url + space padding', `Web Interface http://127.0.0.1:4040${' '.repeat(30_000)}`]
  ]

  for (const [name, line] of cases) {
    it(`scans "${name}" in roughly linear time`, () => {
      const start = performance.now()
      extractTerminalFileLinks(line)
      extractTerminalFileLinkCandidates(line)
      const elapsedMs = performance.now() - start
      expect(elapsedMs).toBeLessThan(500)
    })
  }

  it('still detects separator paths that contain spaces', () => {
    const links = extractTerminalFileLinks('/Users/a/Foo Bar/file.ts')
    expect(links.some((link) => link.pathText === '/Users/a/Foo Bar/file.ts')).toBe(true)
  })

  it('preserves every spaced prefix candidate without stalling on a bounded wrapped line', () => {
    const wordCount = 9_900
    const line = `/tmp/${'a '.repeat(wordCount)}`
    const start = performance.now()
    const links = extractTerminalFileLinkCandidates(line)
    const elapsedMs = performance.now() - start

    expect(links).toHaveLength(wordCount)
    for (let index = 0; index < links.length; index += 1) {
      const words = wordCount - Math.max(0, index - 1)
      const text = line.slice(0, '/tmp/'.length + words * 2 - 1)
      expect(links[index]).toEqual({
        pathText: text,
        displayText: text,
        line: null,
        column: null,
        startIndex: 0,
        endIndex: text.length
      })
    }
    // This fits the 20,000-character hover limit; the old scan took about 300 ms.
    expect(elapsedMs).toBeLessThan(100)
  })
})
