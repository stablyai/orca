import { describe, it, expect } from 'vitest'
import { extractTerminalFileLinks, extractTerminalFileLinkCandidates } from './terminal-links'

// Regression guard for #5970: a full-screen TUI (e.g. ngrok run through Windows
// ConPTY) emits its dashboard as one newline-free line that is mostly alignment
// spaces with a few separators. The spaced-path link regexes used a lookahead
// whose first `[^…]*` segment also matched spaces, overlapping the following
// `\s+` and backtracking catastrophically — freezing the renderer for tens of
// seconds on hover/redraw. These inputs took >1s each before the fix and a few
// ms after; a generous bound keeps the test non-flaky while still catching a
// reintroduced ReDoS (which runs for seconds).
describe('terminal-links ReDoS guard (#5970)', () => {
  const cases: [string, string][] = [
    ['separator + space padding', `a/${' '.repeat(2000)}`],
    ['advertised url + space padding', `Web Interface http://127.0.0.1:4040${' '.repeat(2000)}`]
  ]

  for (const [name, line] of cases) {
    it(`scans "${name}" in roughly linear time`, () => {
      const start = performance.now()
      extractTerminalFileLinks(line)
      extractTerminalFileLinkCandidates(line)
      const elapsedMs = performance.now() - start
      expect(elapsedMs).toBeLessThan(250)
    })
  }

  it('still detects separator paths that contain spaces', () => {
    const links = extractTerminalFileLinks('/Users/a/Foo Bar/file.ts')
    expect(links.some((link) => link.pathText === '/Users/a/Foo Bar/file.ts')).toBe(true)
  })
})
