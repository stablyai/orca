import { describe, expect, it } from 'vitest'
import { buildResolvePullRequestConflictsPrompt } from './source-control/ai/prompts'

describe('buildResolvePullRequestConflictsPrompt', () => {
  it('does not emit unquoted git commands for option-looking base branches', () => {
    const prompt = buildResolvePullRequestConflictsPrompt({
      worktreePath: '/repo/worktree',
      baseRef: '-upload-pack=sh',
      entries: [{ path: 'src/conflict.ts' }]
    })

    expect(prompt).toContain('- PR base branch: "-upload-pack=sh"')
    expect(prompt).toContain('quoting the ref exactly for the current shell')
    expect(prompt).toContain('after verifying the fetched ref exists')
    expect(prompt).not.toContain('git fetch origin -upload-pack=sh')
    expect(prompt).not.toContain('origin/-upload-pack=sh')
  })
})
