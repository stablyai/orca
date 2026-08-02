import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCommitPrompt,
  cleanGeneratedCommitMessage,
  excerptAgentFailureOutput,
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

describe('excerptAgentFailureOutput', () => {
  // Real Codex failure shape: config preamble first, operative ERROR line last.
  const codexErrorLine =
    'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex-spark\' model is not supported when using Codex with a ChatGPT account."}}'
  const codexStderr = [
    '--------',
    'workdir: C:\\Storage\\Projects\\bagplanner',
    'model: gpt-5.3-codex-spark',
    'reasoning effort: medium',
    '--------',
    'user',
    'You are generating a single git commit message...',
    'hook: SessionStart',
    'hook: SessionStart Completed',
    codexErrorLine
  ].join('\n')

  it('excerpts both ends so a tail-anchored Codex error stays visible', () => {
    expect(excerptAgentFailureOutput('', codexStderr)).toBe(
      `-------- workdir: C:\\Storage\\Projects\\bagplanner … ${codexErrorLine.slice(0, 130).trimEnd()}…`
    )
  })

  // Real pi 0.80.6 auth failure: primary line and remedy first, doc paths last.
  const piAuthStderr = [
    'No API key found for github-copilot.',
    '',
    'Use /login to log into a provider via OAuth or API key. See:',
    '  /private/tmp/pi-exit1-repro/node_modules/@earendil-works/pi-coding-agent/docs/providers.md',
    '  /private/tmp/pi-exit1-repro/node_modules/@earendil-works/pi-coding-agent/docs/models.md'
  ].join('\n')

  it('keeps a head-anchored pi auth failure visible', () => {
    expect(excerptAgentFailureOutput('', piAuthStderr)).toBe(
      'No API key found for github-copilot. Use /login to log into a provider via OAuth or API key. See: … /private/tmp/pi-exit1-repro/node_modules/@earendil-works/pi-coding-agent/docs/models.md'
    )
  })

  it('prefers stderr and never excerpts an echoed prompt from stdout', () => {
    expect(
      excerptAgentFailureOutput(
        'You are generating a single git commit message for /secret/repo',
        'No API key found for openai.'
      )
    ).toBe('No API key found for openai.')
  })

  it('falls back to stdout when stderr is blank', () => {
    expect(excerptAgentFailureOutput('Not logged in · Please run /login', ' \n')).toBe(
      'Not logged in · Please run /login'
    )
  })

  it('returns null when both streams are blank', () => {
    expect(excerptAgentFailureOutput('   \n\t', '')).toBeNull()
  })

  it('joins up to three lines without an ellipsis', () => {
    expect(excerptAgentFailureOutput('', 'one\ntwo\nthree\n')).toBe('one two three')
  })

  it('does not parse or unwrap JSON payloads', () => {
    expect(excerptAgentFailureOutput('', '401: {"message":"Invalid API key provided"}')).toBe(
      '401: {"message":"Invalid API key provided"}'
    )
  })

  it('strips ANSI colors and OSC titles', () => {
    const esc = String.fromCharCode(27)
    const bel = String.fromCharCode(7)
    expect(
      excerptAgentFailureOutput(
        '',
        `${esc}]0;pi${bel}${esc}[91mError: no payment method${esc}[0m\n`
      )
    ).toBe('Error: no payment method')
  })

  it('treats bare `\\r` progress frames as line boundaries', () => {
    expect(excerptAgentFailureOutput('', 'Fetching 50%\rFetching 100%\rConnection error.')).toBe(
      'Fetching 50% Fetching 100% Connection error.'
    )
  })

  it('handles CRLF output', () => {
    expect(excerptAgentFailureOutput('', 'one\r\ntwo\r\n')).toBe('one two')
  })

  it('collapses repeated retry lines instead of echoing them twice', () => {
    expect(excerptAgentFailureOutput('', 'Retrying request…\n'.repeat(10))).toBe(
      'Retrying request… Retrying request…'
    )
  })

  it('truncates an overlong single line to the persistence budget', () => {
    const line = `Error: ${'m'.repeat(300)}`
    expect(excerptAgentFailureOutput('', line)).toBe(`Error: ${'m'.repeat(233)}…`)
  })

  it('reads the head and tail windows of oversized multi-line output', () => {
    const stderr = `first line\n${'filler line\n'.repeat(3000)}last: operative error`
    expect(excerptAgentFailureOutput('', stderr)).toBe(
      'first line filler line … last: operative error'
    )
  })

  it('bounds the excerpt for a giant single-line stream', () => {
    expect(excerptAgentFailureOutput('', 'x'.repeat(20_000))).toBe(`${'x'.repeat(100)}…`)
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
