import { describe, expect, it } from 'vitest'
import {
  buildCommitPrompt,
  cleanGeneratedCommitMessage,
  STAGED_DIFF_BYTE_BUDGET,
  truncateDiffForPrompt
} from './commit-message-prompt'

describe('buildCommitPrompt', () => {
  it('embeds the diff into the base prompt', () => {
    const prompt = buildCommitPrompt('diff --git a/foo b/foo\n+hello', '')
    expect(prompt).toContain('diff --git a/foo b/foo')
    expect(prompt).toContain('+hello')
    expect(prompt).toContain('First line: imperative mood')
  })

  it('appends a custom suffix when non-empty', () => {
    const prompt = buildCommitPrompt('diff', 'Use Conventional Commits.')
    expect(prompt).toContain('Additional instructions from user:')
    expect(prompt.endsWith('Use Conventional Commits.')).toBe(true)
  })

  it('does not append the suffix block for whitespace-only suffixes', () => {
    const prompt = buildCommitPrompt('diff', '   \n  ')
    expect(prompt).not.toContain('Additional instructions from user:')
  })
})

describe('truncateDiffForPrompt', () => {
  it('returns the diff unchanged when within budget', () => {
    const diff = 'line\n'.repeat(10)
    expect(truncateDiffForPrompt(diff)).toBe(diff)
  })

  it('truncates and appends a marker when over budget', () => {
    const oversized = 'A'.repeat(STAGED_DIFF_BYTE_BUDGET + 100)
    const result = truncateDiffForPrompt(oversized)
    expect(result.length).toBeLessThan(oversized.length)
    expect(result).toMatch(/diff truncated, 100 bytes omitted/)
  })

  it('honors a custom budget', () => {
    const result = truncateDiffForPrompt('abcdefghij', 5)
    expect(result.startsWith('abcde')).toBe(true)
    expect(result).toMatch(/diff truncated, 5 bytes omitted/)
  })
})

describe('cleanGeneratedCommitMessage', () => {
  it('trims whitespace', () => {
    expect(cleanGeneratedCommitMessage('  feat: hello  \n')).toBe('feat: hello')
  })

  it('strips a single enclosing fenced code block', () => {
    const raw = '```\nfeat: hello\n```'
    expect(cleanGeneratedCommitMessage(raw)).toBe('feat: hello')
  })

  it('strips a fenced block with a language tag', () => {
    const raw = '```text\nfix: bug\n```'
    expect(cleanGeneratedCommitMessage(raw)).toBe('fix: bug')
  })

  it('drops a leading "Generating…" preamble line', () => {
    const raw = 'Generating…\nfeat: hello world'
    expect(cleanGeneratedCommitMessage(raw)).toBe('feat: hello world')
  })

  it('normalizes CRLF line endings', () => {
    expect(cleanGeneratedCommitMessage('feat: a\r\nbody line\r\n')).toBe('feat: a\nbody line')
  })

  it('returns empty string when input is whitespace', () => {
    expect(cleanGeneratedCommitMessage('   \n\t')).toBe('')
  })
})
