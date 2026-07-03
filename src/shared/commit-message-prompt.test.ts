import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCommitPrompt,
  cleanGeneratedCommitMessage,
  extractAgentErrorMessage,
  planCustomCommand,
  STAGED_DIFF_BYTE_BUDGET,
  tokenizeCustomCommandTemplate,
  truncateDiffForPrompt
} from './commit-message-prompt'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildCommitPrompt', () => {
  it('embeds the diff into the base prompt', () => {
    const prompt = buildCommitPrompt('diff --git a/foo b/foo\n+hello', '')
    expect(prompt).toContain('diff --git a/foo b/foo')
    expect(prompt).toContain('+hello')
    expect(prompt).toContain('First line: imperative mood')
  })

  it('appends a custom suffix when non-empty', () => {
    const prompt = buildCommitPrompt('diff', 'Use Conventional Commits.')
    expect(prompt).toContain('Additional user prompt:')
    expect(prompt.endsWith('Use Conventional Commits.')).toBe(true)
  })

  it('does not append the suffix block for whitespace-only suffixes', () => {
    const prompt = buildCommitPrompt('diff', '   \n  ')
    expect(prompt).not.toContain('Additional user prompt:')
  })
})

describe('truncateDiffForPrompt', () => {
  it('returns the diff unchanged when within budget', () => {
    const diff = 'line\n'.repeat(10)
    expect(truncateDiffForPrompt(diff)).toBe(diff)
  })

  it('truncates and appends a marker when over budget', () => {
    const oversized = `${'line\n'.repeat(STAGED_DIFF_BYTE_BUDGET / 5 + 100)}`
    const result = truncateDiffForPrompt(oversized)
    expect(result.length).toBeLessThan(oversized.length)
    expect(result).toMatch(/diff truncated, \d+ bytes omitted/)
  })

  it('clips on a line boundary so the diff is never cut mid-line', () => {
    const diff = `${'keep this line\n'.repeat(40)}`
    const result = truncateDiffForPrompt(diff, 95)
    const body = result.split('\n...(diff truncated')[0]
    // Every retained line is whole.
    for (const line of body.split('\n').filter(Boolean)) {
      expect(line).toBe('keep this line')
    }
  })

  it('keeps clipped output within a tight custom budget', () => {
    const files = Array.from(
      { length: 20 },
      (_, i) => `diff --git a/file-${i}.txt b/file-${i}.txt\n${'+x\n'.repeat(200)}`
    ).join('')
    const result = truncateDiffForPrompt(files, 120)

    expect(result.length).toBeLessThanOrEqual(120)
  })

  it('shares the budget fairly so a huge file does not starve a small one', () => {
    const hugeFile = `diff --git a/data.jsonl b/data.jsonl\n${'+x\n'.repeat(5000)}`
    const smallFile = 'diff --git a/src/app.ts b/src/app.ts\n+const meaningful = true\n'
    const result = truncateDiffForPrompt(`${hugeFile}${smallFile}`, 1_000)

    // The small, human-authored change survives instead of being cut off.
    expect(result).toContain('a/src/app.ts')
    expect(result).toContain('const meaningful = true')
    // The huge file is clipped, not the small one.
    expect(result).toMatch(/diff truncated, \d+ bytes omitted/)
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

  it('cleans large fenced CRLF output without regex-wide normalization', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const fence = '```'
    const raw = `\r\n${fence}text\r\nfeat: large output\r\n${'body line\r\n'.repeat(10_000)}${fence}\r\n`

    const result = cleanGeneratedCommitMessage(raw)

    expect(result.startsWith('feat: large output\nbody line')).toBe(true)
    expect(result.endsWith('body line')).toBe(true)
    expect(result).not.toContain('\r\n')
    const usedCrlfReplace = replaceSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r\\n'
    )
    const usedFenceMatch = matchSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source.includes('[\\s\\S]')
    )
    expect(usedCrlfReplace).toBe(false)
    expect(usedFenceMatch).toBe(false)
  })

  it('strips a leading list marker from the commit subject', () => {
    expect(cleanGeneratedCommitMessage('● Add Copilot entry to agent results')).toBe(
      'Add Copilot entry to agent results'
    )
    expect(cleanGeneratedCommitMessage('1. Add numbered entry')).toBe('Add numbered entry')
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

  it('returns the payload for non-JSON error lines', () => {
    const out = 'preamble line\nERROR: {bad json oops'
    expect(extractAgentErrorMessage(out, '')).toBe('{bad json oops')
  })

  it('uses the last ERROR line when several are emitted', () => {
    const out = ['ERROR: first failure', 'retry message', 'ERROR: second failure'].join('\n')
    expect(extractAgentErrorMessage(out, '')).toBe('second failure')
  })

  it('uses the last ERROR line in large CRLF output without line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const out = `${'preamble\r\n'.repeat(10_000)}ERROR: first failure\r\nretry\r\nERROR: second failure\r\n`

    expect(extractAgentErrorMessage(out, '')).toBe('second failure')

    const usedLineSplit = splitSpy.mock.calls.some(
      ([separator]) => separator instanceof RegExp && separator.source === '\\r?\\n'
    )
    expect(usedLineSplit).toBe(false)
  })

  it('matches an `Error:` line emitted on stdout', () => {
    expect(extractAgentErrorMessage('Error: model unavailable\n', '')).toBe('model unavailable')
  })

  it('matches ANSI-colored `Error:` lines emitted by CLIs', () => {
    expect(
      extractAgentErrorMessage('', '\u001b[91m\u001b[1mError: \u001b[0mNo payment method\n')
    ).toBe('No payment method')
  })

  it('matches tool-specific `Error during ...:` lines', () => {
    expect(
      extractAgentErrorMessage(
        '',
        'Error during droid execution: Authentication failed. Please log into Factory.\n'
      )
    ).toBe('Authentication failed. Please log into Factory.')
  })

  it('matches wrapped provider error-code payloads with quoted message fields', () => {
    const stdout = [
      "Error code: 401 - {'error': {'message': 'The API Key appears to be invalid or ma",
      "y have expired. Please verify your credentials and try again.', 'type': 'invalid",
      "_authentication_error'}}"
    ].join('\n')
    expect(extractAgentErrorMessage(stdout, '')).toBe(
      'The API Key appears to be invalid or may have expired. Please verify your credentials and try again.'
    )
  })

  it('extracts wrapped provider error-code payloads from large output without replacement passes', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const echoedPrompt = 'echoed pasted prompt '.repeat(10_000)
    const stdout = [
      `${echoedPrompt}Error code: 401 - {'error': {'message': 'The API Key appears to be invalid or ma`,
      "y have expired. Please verify your credentials and try again.', 'type': 'invalid",
      "_authentication_error'}}"
    ].join('\r\n')

    expect(extractAgentErrorMessage(stdout, '')).toBe(
      'The API Key appears to be invalid or may have expired. Please verify your credentials and try again.'
    )
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('does not strip ANSI across a paste-sized single-line log before error-code fallback', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const pastedLog = 'x'.repeat(20_000)
    const stdout = `${pastedLog}Error code: 400 - {'message': 'bad request'}`

    expect(extractAgentErrorMessage(stdout, '')).toBe('bad request')
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('returns null when no ERROR line is present', () => {
    expect(extractAgentErrorMessage('plain log\nmore log\n', '')).toBeNull()
  })

  it('returns the JSON payload `message` field when no nested error is set', () => {
    const out = 'ERROR: {"message":"top-level only"}'
    expect(extractAgentErrorMessage(out, '')).toBe('top-level only')
  })
})

describe('tokenizeCustomCommandTemplate', () => {
  it('splits on whitespace', () => {
    const r = tokenizeCustomCommandTemplate('claude -p')
    expect(r).toEqual({ ok: true, tokens: ['claude', '-p'] })
  })

  it('groups double-quoted segments with spaces', () => {
    const r = tokenizeCustomCommandTemplate('claude --msg "hello world"')
    expect(r).toEqual({ ok: true, tokens: ['claude', '--msg', 'hello world'] })
  })

  it('groups single-quoted segments verbatim', () => {
    const r = tokenizeCustomCommandTemplate(`agent --json '{"k":"v"}'`)
    expect(r).toEqual({ ok: true, tokens: ['agent', '--json', '{"k":"v"}'] })
  })

  it('honors backslash escapes inside double quotes', () => {
    const r = tokenizeCustomCommandTemplate('claude --msg "she said \\"hi\\""')
    expect(r).toEqual({ ok: true, tokens: ['claude', '--msg', 'she said "hi"'] })
  })

  it('keeps adjacent quoted/unquoted regions in one token (a"b"c → abc)', () => {
    const r = tokenizeCustomCommandTemplate('foo a"b"c')
    expect(r).toEqual({ ok: true, tokens: ['foo', 'abc'] })
  })

  it('returns an error for an unclosed quote', () => {
    const r = tokenizeCustomCommandTemplate('claude --msg "no end')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/unclosed/i)
    }
  })

  it('returns an empty token list for whitespace-only input', () => {
    const r = tokenizeCustomCommandTemplate('   \t  ')
    expect(r).toEqual({ ok: true, tokens: [] })
  })
})

describe('planCustomCommand', () => {
  it('routes prompt via stdin when {prompt} is absent', () => {
    const r = planCustomCommand('claude -p', 'COMMIT MSG')
    expect(r).toEqual({ ok: true, binary: 'claude', args: ['-p'], stdinPayload: 'COMMIT MSG' })
  })

  it('substitutes {prompt} as a whole token via argv', () => {
    const r = planCustomCommand('codex exec {prompt}', 'PROMPT')
    expect(r).toEqual({ ok: true, binary: 'codex', args: ['exec', 'PROMPT'], stdinPayload: null })
  })

  it('treats "{prompt}" identically to bare {prompt} (no shell, no double-quoting)', () => {
    const a = planCustomCommand('codex exec {prompt}', 'PROMPT')
    const b = planCustomCommand('codex exec "{prompt}"', 'PROMPT')
    expect(a).toEqual(b)
  })

  it('substitutes {prompt} embedded inside a token', () => {
    const r = planCustomCommand('agent --msg={prompt}', 'PROMPT')
    expect(r).toEqual({
      ok: true,
      binary: 'agent',
      args: ['--msg=PROMPT'],
      stdinPayload: null
    })
  })

  it('errors on empty templates', () => {
    const r = planCustomCommand('   ', 'PROMPT')
    expect(r.ok).toBe(false)
  })

  it('propagates tokenizer errors', () => {
    const r = planCustomCommand('agent "unclosed', 'PROMPT')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/unclosed/i)
    }
  })
})
