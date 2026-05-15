import { describe, expect, it } from 'vitest'
import { buildCommitMessagePrompt, splitGeneratedCommitMessage } from './commit-message-generation'

describe('buildCommitMessagePrompt', () => {
  it('builds a prompt from staged context instead of asking the agent to inspect git', () => {
    const prompt = buildCommitMessagePrompt(
      {
        branch: 'feature/commit-drafts',
        stagedSummary: 'M\tsrc/main/ipc/filesystem.ts',
        stagedPatch: 'diff --git a/src/main/ipc/filesystem.ts b/src/main/ipc/filesystem.ts\n+hello'
      },
      ''
    )

    expect(prompt).toContain('Branch: feature/commit-drafts')
    expect(prompt).toContain('Staged files:\nM\tsrc/main/ipc/filesystem.ts')
    expect(prompt).toContain('Staged patch:\n```diff')
    expect(prompt).toContain('+hello')
    expect(prompt).toContain('Use only the staged changes below as context.')
    expect(prompt).not.toContain('Additional instructions from user:')
  })

  it('keeps custom instructions in a separate bounded section', () => {
    const prompt = buildCommitMessagePrompt(
      {
        branch: null,
        stagedSummary: 'A\tREADME.md',
        stagedPatch: '+docs'
      },
      'Use Conventional Commits.'
    )

    expect(prompt).toContain('Branch: (detached)')
    expect(prompt).toContain('Additional instructions from user:\nUse Conventional Commits.')
  })
})

describe('splitGeneratedCommitMessage', () => {
  it('normalizes subject and preserves body text', () => {
    const result = splitGeneratedCommitMessage(
      'Fix source control generation.\n\n- Move planning into main'
    )

    expect(result).toEqual({
      subject: 'Fix source control generation',
      body: '- Move planning into main',
      message: 'Fix source control generation\n\n- Move planning into main'
    })
  })
})
