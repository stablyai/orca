import { describe, expect, it } from 'vitest'
import { dotenvPasteToBatch, parseDotenvPaste } from './dotenv-paste'

describe('parseDotenvPaste', () => {
  it('reads comments, export, quotes, inline comments and multi-line values', () => {
    const entries = parseDotenvPaste(
      [
        '# database',
        '',
        'export DATABASE_URL=postgres://db/app # local',
        "SINGLE='a #literal $x'",
        'DOUBLE="line1\\nline2 \\"q\\""',
        'PEM="-----BEGIN KEY-----',
        'abc',
        '-----END KEY-----"',
        'SPACED = padded value  '
      ].join('\r\n')
    )
    expect(entries.map(({ line, name, value, issue }) => ({ line, name, value, issue }))).toEqual([
      { line: 3, name: 'DATABASE_URL', value: 'postgres://db/app', issue: null },
      { line: 4, name: 'SINGLE', value: 'a #literal $x', issue: null },
      { line: 5, name: 'DOUBLE', value: 'line1\nline2 "q"', issue: null },
      { line: 6, name: 'PEM', value: '-----BEGIN KEY-----\nabc\n-----END KEY-----', issue: null },
      { line: 9, name: 'SPACED', value: 'padded value', issue: null }
    ])
  })

  it('flags bad lines per line and lets the last duplicate win', () => {
    const entries = parseDotenvPaste(
      [
        'not an assignment',
        'lower=1',
        'PATH=/bin',
        'CLAUDE_CODE_OAUTH_TOKEN=x',
        'ANTHROPIC_API_KEY=sk-ant-oat01-abcdef',
        'ANTHROPIC_BASE_URL=http://localhost:8080',
        'EMPTY=',
        'TOKEN=first',
        'TOKEN=second',
        'OPEN="never closed'
      ].join('\n')
    )
    expect(entries.map((entry) => entry.issue)).toEqual([
      'syntax',
      'invalid_name',
      'reserved_name',
      'subscription_token_refused',
      'subscription_token_refused',
      'invalid_base_url',
      'invalid_value',
      'overridden',
      null,
      'unterminated_quote'
    ])
    expect(entries.find((entry) => entry.name === 'ANTHROPIC_API_KEY')?.kind).toBe('agent_key')
    expect(dotenvPasteToBatch(entries)).toEqual({ TOKEN: 'second' })
  })
})
