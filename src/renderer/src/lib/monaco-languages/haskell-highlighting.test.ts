// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { monaco } from '../monaco-setup'
import { detectLanguage } from '../../../../shared/editor-language/editor-language-detect'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

describe('Haskell highlighting through production Monaco setup', () => {
  it.each(['Main.hs', 'Signature.hsig', 'Main.hs-boot', 'C:\\folder workspace\\MAIN.HSIG'])(
    'recognizes and tokenizes %s through production Monaco setup',
    async (filename) => {
      const language = detectLanguage(filename)
      expect(language).toBe('haskell')
      const source =
        'module Main where\n-- comment\nanswer :: Int\nanswer = 42\nmain = putStrLn "hello"'
      await monaco.editor.colorize(source, language, {})
      const tokens = monaco.editor.tokenize(source, language)
      expect(tokens[0].map((token) => token.type)).toContain('keyword.other.module.haskell')
      expect(new Set(tokens[1].map((token) => token.type))).toEqual(new Set(['comment.haskell']))
      expect(tokens[2].map((token) => token.type)).toEqual(
        expect.arrayContaining(['type.identifier.haskell', 'type.haskell'])
      )
      expect(tokens[3].map((token) => token.type)).toContain('number.haskell')
      expect(tokens[4].map((token) => token.type)).toContain('string.quoted.double.haskell')
    }
  )

  it('highlights a signature module in an hsig model', async () => {
    const source = 'signature Example where\nanswer :: Int'
    const language = detectLanguage('Example.hsig')
    await monaco.editor.colorize(source, language, {})
    const tokens = monaco.editor.tokenize(source, language)
    expect(tokens[0].map((token) => token.type)).toContain('keyword.other.signature.haskell')
    expect(tokens[1].map((token) => token.type)).toContain('type.haskell')
  })

  it('retains the tokenization limit and leaves unknown following state plain', async () => {
    const source = `${'x'.repeat(1001)}\nanswer = 42`
    await monaco.editor.colorize(source, 'haskell', {})
    const tokens = monaco.editor.tokenize(source, 'haskell')
    expect(tokens.map((line) => line.map((token) => token.type))).toEqual([
      ['source.haskell'],
      ['source.haskell']
    ])
  })

  it('keeps unrelated built-in language highlighting intact', async () => {
    await monaco.editor.colorize('const answer = 42', 'typescript', {})
    expect(
      monaco.editor.tokenize('const answer = 42', 'typescript')[0].map((token) => token.type)
    ).toEqual(expect.arrayContaining(['keyword.ts', 'number.ts']))
    await monaco.editor.colorize('answer = 42 # comment', 'python', {})
    expect(
      monaco.editor.tokenize('answer = 42 # comment', 'python')[0].map((token) => token.type)
    ).toEqual(expect.arrayContaining(['number.python', 'comment.python']))
  })

  it('carries nested comments across lines and returns to code after both closers', async () => {
    const source = '{- outer {- inner\n-} still outer\n-}\nanswer = 42\ntext = "-- literal"'
    await monaco.editor.colorize(source, 'haskell', {})
    const tokens = monaco.editor.tokenize(source, 'haskell')
    expect(new Set(tokens[0].map((token) => token.type))).toEqual(new Set(['comment.haskell']))
    expect(new Set(tokens[1].map((token) => token.type))).toEqual(new Set(['comment.haskell']))
    expect(tokens[3].map((token) => token.type)).toContain('number.haskell')
    expect(tokens[3].map((token) => token.type)).not.toContain('comment.haskell')
    expect(tokens[4].map((token) => token.type)).toContain('string.quoted.double.haskell')
    expect(tokens[4].map((token) => token.type)).not.toContain('comment.haskell')
  })
})
