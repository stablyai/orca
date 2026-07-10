import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCommitMessagePrompt, splitGeneratedCommitMessage } from './commit-message-generation'

afterEach(() => {
  vi.restoreAllMocks()
})

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
    expect(prompt).not.toContain('Additional user prompt:')
  })

  it('keeps a custom prompt in a separate bounded section', () => {
    const prompt = buildCommitMessagePrompt(
      {
        branch: null,
        stagedSummary: 'A\tREADME.md',
        stagedPatch: '+docs'
      },
      'Use Conventional Commits.'
    )

    expect(prompt).toContain('Branch: (detached)')
    expect(prompt).toContain('Additional user prompt:\nUse Conventional Commits.')
  })

  it('notes when the diff was omitted so the agent relies on the file list', () => {
    const prompt = buildCommitMessagePrompt(
      {
        branch: 'feature/big-diff',
        stagedSummary: 'A\thuge.jsonl',
        stagedPatch: ''
      },
      ''
    )

    expect(prompt).toContain('Staged files:\nA\thuge.jsonl')
    expect(prompt).toContain('diff omitted — too large to read')
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

  it('extracts subject and body from newline-heavy output without line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const body = '- Explain one generated change\n'.repeat(10_000).trimEnd()

    const result = splitGeneratedCommitMessage(`Add generated paste protection\n\n${body}`)

    expect(result.subject).toBe('Add generated paste protection')
    expect(result.body.startsWith('- Explain one generated change\n')).toBe(true)
    expect(result.body.endsWith('- Explain one generated change')).toBe(true)
    const usedLineSplit = splitSpy.mock.calls.some(
      ([separator]) => typeof separator === 'string' && separator === '\n'
    )
    expect(usedLineSplit).toBe(false)
  })
})
