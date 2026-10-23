import { performance } from 'node:perf_hooks'
import { describe, it, expect } from 'vitest'
import { extractTerminalFileLinks, extractTerminalFileLinkCandidates } from './terminal-links'

// Regression guard for #5970: a full-screen TUI (e.g. ngrok run through Windows
// ConPTY) emits its dashboard as one newline-free line that is mostly alignment
// spaces with a few separators. Keep these non-matching inputs large enough to
// catch overlapping whitespace backtracking without making normal CI noisy.
describe('terminal-links ReDoS guard (#5970)', () => {
  const cases: [string, string][] = [
    ['unclosed Markdown destinations', '[/tmp/a.pdf]('.repeat(2500)],
    ['nested Markdown label', `${'['.repeat(30000)}/tmp/a.pdf](/tmp/b.pdf)`],
    ['oversized Markdown destination', `[file](/tmp/${'a'.repeat(30000)}.pdf)`],
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
})
