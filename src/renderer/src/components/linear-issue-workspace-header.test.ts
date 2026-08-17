import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'LinearIssueWorkspace.tsx'), 'utf8')

function headerSource(): string {
  const start = source.indexOf('<header className="flex h-[61px]')
  const end = source.indexOf('</header>', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('LinearIssueWorkspace header actions', () => {
  it('exposes copy, open-on-Linear, and a labeled start-workspace control', () => {
    const header = headerSource()

    expect(header).toContain("copyTextToClipboard(displayed.url, 'URL')")
    expect(header).toContain('window.api.shell.openUrl(displayed.url)')
    expect(header).toContain("'Open on Linear'")
    expect(header).toContain('<Copy className="size-4" />')
    expect(header).toContain('<ExternalLink className="size-4" />')
    expect(header).toContain("'Start workspace'")
    expect(header).toContain("'Start workspace from issue'")
    expect(header).not.toContain("'Copy issue identifier'")
    expect(header).toMatch(/size="sm"[\s\S]*onClick=\{handleOpenOrUseIssue\}/)
    expect(header).not.toMatch(/size="icon-sm"\s+onClick=\{handleOpenOrUseIssue\}/)
  })
})
