// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadHaskellTextMateGrammar, registerHaskellLanguage } from './register-haskell'
import type { TextMateTokensProviderOptions } from './textmate-token-provider'
import type * as TextMateProvider from './textmate-token-provider'
import { loadNodeOniguruma } from './textmate-oniguruma-fixture'

const providerRequests = vi.hoisted(() => vi.fn())
const disposers: (() => void)[] = []

vi.mock('./textmate-token-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof TextMateProvider>()
  return {
    ...actual,
    createTextMateTokensProvider: (options: TextMateTokensProviderOptions) => {
      providerRequests()
      return actual.createTextMateTokensProvider({ ...options, loadOniguruma: loadNodeOniguruma })
    }
  }
})

beforeAll(() => {
  const registration = vi.spyOn(monaco.languages, 'register')
  const configuration = vi.spyOn(monaco.languages, 'setLanguageConfiguration')
  const factory = vi.spyOn(monaco.languages, 'registerTokensProviderFactory')
  registerHaskellLanguage(monaco)
  expect(providerRequests).not.toHaveBeenCalled()
  registerHaskellLanguage(monaco)
  expect(registration).toHaveBeenCalledTimes(1)
  for (const call of [...configuration.mock.results, ...factory.mock.results]) {
    if (call.type === 'return') {
      disposers.push(() => call.value.dispose())
    }
  }
})

afterAll(() => {
  for (const dispose of disposers.splice(0).toReversed()) {
    dispose()
  }
  vi.restoreAllMocks()
})

describe('Haskell through the installed Monaco tokenizer', () => {
  it('lazily colors recognized source, types, numbers, strings, and comments', async () => {
    const source = [
      'module Main where',
      '-- comment',
      'answer :: Int',
      'answer = 42',
      'main = putStrLn "hello"'
    ].join('\n')
    await monaco.editor.colorize(source, 'haskell', {})
    expect(providerRequests).toHaveBeenCalledTimes(1)
    const tokens = monaco.editor.tokenize(source, 'haskell')
    const scopes = (line: number) => tokens[line].map((token) => token.type)

    expect(scopes(0)).toContain('keyword.other.module.haskell')
    expect(new Set(scopes(1))).toEqual(new Set(['comment.haskell']))
    expect(scopes(2)).toEqual(expect.arrayContaining(['type.identifier.haskell', 'type.haskell']))
    expect(scopes(3)).toContain('number.haskell')
    expect(scopes(4)).toContain('string.quoted.double.haskell')
    expect(monaco.languages.getLanguages().find(({ id }) => id === 'haskell')?.extensions).toEqual([
      '.hs',
      '.hsig',
      '.hs-boot'
    ])
  })

  it('keeps nested comments active and returns to code after both closers', async () => {
    const source = [
      '{- outer {- inner',
      '-} still outer',
      '-}',
      'answer = 42',
      'text = "-- literal"'
    ].join('\n')
    await monaco.editor.colorize(source, 'haskell', {})
    const tokens = monaco.editor.tokenize(source, 'haskell')

    expect(new Set(tokens[0].map((token) => token.type))).toEqual(new Set(['comment.haskell']))
    expect(new Set(tokens[1].map((token) => token.type))).toEqual(new Set(['comment.haskell']))
    expect(tokens[3].map((token) => token.type)).toContain('number.haskell')
    expect(tokens[3].map((token) => token.type)).not.toContain('comment.haskell')
    expect(tokens[4].map((token) => token.type)).toContain('string.quoted.double.haskell')
    expect(tokens[4].map((token) => token.type)).not.toContain('comment.haskell')
  })

  it('does not load a grammar for an unrelated scope', async () => {
    await expect(loadHaskellTextMateGrammar('source.python')).resolves.toBeNull()
  })
})
