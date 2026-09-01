import { describe, expect, it } from 'vitest'
import {
  canonicalizeAgentArgsLineEndings,
  serializeAgentArgsTokens,
  tokenizeAgentArgsTemplate
} from './agent-args-tokenizer'

function tokens(template: string): string[] {
  const result = tokenizeAgentArgsTemplate(template)
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.reason} at ${result.index}`)
  }
  return result.tokens
}

function failure(template: string): string {
  const result = tokenizeAgentArgsTemplate(template)
  if (result.ok) {
    throw new Error(`expected failure, got tokens ${JSON.stringify(result.tokens)}`)
  }
  return result.reason
}

describe('tokenizeAgentArgsTemplate', () => {
  it('splits on unquoted spaces, tabs, and newlines', () => {
    expect(tokens('--model x --safe')).toEqual(['--model', 'x', '--safe'])
    expect(tokens('--model x\n--safe')).toEqual(['--model', 'x', '--safe'])
    expect(tokens('--model\tx\r\n--safe')).toEqual(['--model', 'x', '--safe'])
    expect(tokens('  leading   and	trailing  ')).toEqual(['leading', 'and', 'trailing'])
  })

  it('returns no tokens for empty or whitespace-only templates', () => {
    expect(tokens('')).toEqual([])
    expect(tokens(' \n\t ')).toEqual([])
  })

  it('groups quoted text and keeps spaces and = inside one token', () => {
    expect(tokens('--name "hello world"')).toEqual(['--name', 'hello world'])
    expect(tokens("--name 'hello world'")).toEqual(['--name', 'hello world'])
    expect(tokens('--opt "KEY=some value"')).toEqual(['--opt', 'KEY=some value'])
  })

  it('retains empty quoted tokens and collapses an empty-quote run to one empty token', () => {
    expect(tokens('--flag ""')).toEqual(['--flag', ''])
    expect(tokens("''")).toEqual([''])
    expect(tokens(`""''""`)).toEqual([''])
  })

  it('concatenates adjacent segments not separated by unquoted whitespace', () => {
    expect(tokens('a"b"c')).toEqual(['abc'])
    expect(tokens(`pre'mid'post`)).toEqual(['premidpost'])
    expect(tokens('--x="quoted val"')).toEqual(['--x=quoted val'])
  })

  it('keeps backslashes literal except before whitespace, quotes, or backslash', () => {
    expect(tokens('C:\\Users\\me')).toEqual(['C:\\Users\\me'])
    expect(tokens('foo\\ bar')).toEqual(['foo bar'])
    expect(tokens('a\\"b')).toEqual(['a"b'])
    expect(tokens('a\\\\b')).toEqual(['a\\b'])
    expect(tokens('esc\\aped')).toEqual(['esc\\aped'])
  })

  it('accepts a trailing literal backslash', () => {
    expect(tokens('C:\\dir\\')).toEqual(['C:\\dir\\'])
    expect(tokens('lone \\')).toEqual(['lone', '\\'])
  })

  it('decodes only \\" and \\\\ inside double quotes; single quotes are fully literal', () => {
    expect(tokens('"a\\"b"')).toEqual(['a"b'])
    expect(tokens('"a\\\\b"')).toEqual(['a\\b'])
    expect(tokens('"C:\\Users\\me"')).toEqual(['C:\\Users\\me'])
    expect(tokens("'a\\nb'")).toEqual(['a\\nb'])
  })

  it('treats shell operators, globs, and expansions as data', () => {
    expect(tokens('a&&b || c | d > e < f $(g) `h` $VAR %VAR% *.ts')).toEqual([
      'a&&b',
      '||',
      'c',
      '|',
      'd',
      '>',
      'e',
      '<',
      'f',
      '$(g)',
      '`h`',
      '$VAR',
      '%VAR%',
      '*.ts'
    ])
  })

  it('rejects unterminated quotes', () => {
    expect(failure('"open')).toBe('unterminated_quote')
    expect(failure("'open")).toBe('unterminated_quote')
    expect(failure('ok "open')).toBe('unterminated_quote')
  })

  it('rejects line breaks inside either quote form', () => {
    expect(failure('"a\nb"')).toBe('quoted_line_break')
    expect(failure("'a\nb'")).toBe('quoted_line_break')
    expect(failure('"a\rb"')).toBe('quoted_line_break')
  })

  it('rejects disallowed control characters', () => {
    expect(failure('a\0b')).toBe('control_char')
    expect(failure('a\x07b')).toBe('control_char')
    expect(failure('a\x7fb')).toBe('control_char')
    expect(failure('a\u0085b')).toBe('control_char')
    expect(failure('"a\tb"')).toBe('control_char')
  })
})

describe('canonicalizeAgentArgsLineEndings', () => {
  it('normalizes CRLF and bare CR to LF', () => {
    expect(canonicalizeAgentArgsLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })
})

describe('serializeAgentArgsTokens', () => {
  it('round-trips through the tokenizer', () => {
    const cases: string[][] = [
      ['--model', 'x', '--safe'],
      ['hello world', ''],
      ['C:\\Users\\me', 'a"b', "single'quote"],
      ['KEY=some value', '$(not expanded)', '%VAR%']
    ]
    for (const original of cases) {
      const serialized = serializeAgentArgsTokens(original)
      expect(tokens(serialized)).toEqual(original)
    }
  })
})
