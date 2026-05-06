import { describe, expect, it } from 'vitest'
import {
  buildCommitPrompt,
  cleanGeneratedCommitMessage,
  extractAgentErrorMessage,
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

describe('extractAgentErrorMessage', () => {
  it('returns the inner message from a Codex JSON error payload', () => {
    const stderr = [
      '--------',
      'workdir: C:\\Storage\\Projects\\bagplanner',
      'model: gpt-5.3-codex-spark',
      'reasoning effort: medium',
      '--------',
      'user',
      'You are generating a single git commit message...',
      'hook: SessionStart',
      'hook: SessionStart Completed',
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex-spark\' model is not supported when using Codex with a ChatGPT account."}}'
    ].join('\n')
    expect(extractAgentErrorMessage('', stderr)).toBe(
      "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."
    )
  })

  it('falls back to the raw payload when the JSON cannot be parsed', () => {
    const out = 'preamble line\nERROR: {bad json oops'
    expect(extractAgentErrorMessage(out, '')).toBe('{bad json oops')
  })

  it('uses the last ERROR line when several are emitted', () => {
    const out = ['ERROR: first failure', 'retry message', 'ERROR: second failure'].join('\n')
    expect(extractAgentErrorMessage(out, '')).toBe('second failure')
  })

  it('matches an `Error:` line emitted on stdout', () => {
    expect(extractAgentErrorMessage('Error: model unavailable\n', '')).toBe('model unavailable')
  })

  it('returns null when no ERROR line is present', () => {
    expect(extractAgentErrorMessage('plain log\nmore log\n', '')).toBeNull()
  })

  it('returns the JSON payload `message` field when no nested error is set', () => {
    const out = 'ERROR: {"message":"top-level only"}'
    expect(extractAgentErrorMessage(out, '')).toBe('top-level only')
  })
})
