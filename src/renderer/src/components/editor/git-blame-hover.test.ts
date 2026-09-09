import { describe, expect, it } from 'vitest'
import type { GitBlameRange } from '../../../../shared/git-blame'
import { buildGitBlameHoverMarkdown } from './git-blame-hover'

const range: GitBlameRange = {
  startLine: 1,
  endLine: 1,
  commitId: 'a'.repeat(40),
  author: 'Attacker](command:run)[',
  authorEmail: '<img src=x onerror=alert(1)>',
  authoredAt: 1_725_235_200,
  summary: '[Run](command:workbench.action.terminal.new)\n**trusted**'
}

describe('Git blame hover Markdown', () => {
  it('escapes Git-controlled metadata before rendering it in Monaco', () => {
    const markdown = buildGitBlameHoverMarkdown(range).value

    expect(markdown).not.toContain('](command:')
    expect(markdown).not.toContain('<img')
    expect(markdown).not.toContain('**trusted**')
    expect(markdown).toContain('\\]\\(command:run\\)\\[')
    expect(markdown).toContain('&lt;img src=x onerror=alert\\(1\\)&gt;')
  })
})
