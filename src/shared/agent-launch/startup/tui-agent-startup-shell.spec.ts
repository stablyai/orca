import { describe, expect, it } from 'vitest'
import { clearEnvCommand, tokenizeStartupCommand } from './tui-agent-startup-shell'
import { buildAgentDraftLaunchPlan } from './tui-agent-startup'

function expectSpansCoverTokens(source: string, shell: 'powershell' | 'cmd'): string[] {
  const result = tokenizeStartupCommand(source, shell)
  expect(result.ok).toBe(true)
  if (!result.ok) {
    return []
  }
  expect(result.spans).toHaveLength(result.tokens.length)
  let previousEnd = 0
  for (const [index, { start, end }] of result.spans.entries()) {
    expect(start).toBeGreaterThanOrEqual(previousEnd)
    expect(end).toBeGreaterThan(start)
    // Every raw span must re-tokenize to exactly its own token.
    const slice = tokenizeStartupCommand(source.slice(start, end), shell)
    expect(slice.ok && slice.tokens).toEqual([result.tokens[index]])
    previousEnd = end
  }
  return result.spans.map(({ start, end }) => source.slice(start, end))
}

describe('tokenizeStartupCommand spans (windows shells)', () => {
  it('starts a span at a token-leading escape character', () => {
    expect(expectSpansCoverTokens('claude ^&literal next', 'cmd')).toEqual([
      'claude',
      '^&literal',
      'next'
    ])
    expect(expectSpansCoverTokens('claude `x tail', 'powershell')).toEqual(['claude', '`x', 'tail'])
  })

  it('spans a powershell doubled-quote token as one raw range', () => {
    expect(expectSpansCoverTokens("claude 'a''b' end", 'powershell')).toEqual([
      'claude',
      "'a''b'",
      'end'
    ])
  })

  it('spans a token opened by a quote at end of input', () => {
    expect(expectSpansCoverTokens('claude ""', 'cmd')).toEqual(['claude', '""'])
  })
})

describe('one Unix startup dialect', () => {
  it.each([
    'FOO; rm -rf /tmp/x',
    'FOO BAR',
    '',
    '1LEADING_DIGIT',
    'has-dash',
    '$FOO',
    'PATH\nHOME'
  ])('refuses %j as an environment variable name', (bad) => {
    // Interpolated names must be identifiers; shell syntax would inject commands and fish erase could delete session variables.
    expect(() => clearEnvCommand(bad, 'posix')).toThrow(/not an environment variable name/)
    expect(() => clearEnvCommand(['OK', bad], 'posix')).toThrow(/not an environment variable name/)
  })

  it('leaves a multi-line argv draft to the paste fallback in cmd.exe', () => {
    const draft = 'Linked Linear issue: ENG-1\nhttps://linear.app/acme/issue/ENG-1'
    const args = { agent: 'claude' as const, draft, cmdOverrides: {}, platform: 'win32' as const }

    expect(buildAgentDraftLaunchPlan({ ...args, shell: 'cmd' })).toBeNull()
    expect(buildAgentDraftLaunchPlan({ ...args, shell: 'powershell' })?.launchCommand).toContain(
      '`n'
    )
  })
})
