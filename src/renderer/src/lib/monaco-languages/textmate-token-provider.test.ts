// @vitest-environment happy-dom
import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { Grammar } from 'shiki/core'
import type * as ShikiTextmate from 'shiki/textmate'
import { expect, it } from 'vitest'
import { createTokensProvider } from './textmate-token-provider'
import type { TextMateCore } from '../syntax-highlighting/textmate-core'

const SCOPE = 'source.test'
const HEADING = '# '
const LONG = 'x'.repeat(1001)

// A stack of scope names stands in for shiki's immutable rule stack; a heading opens a scope the next line inherits.
const ROOT = ['root'] as unknown as ShikiTextmate.StateStack
const HEADING_OPEN = ['root', 'heading'] as unknown as ShikiTextmate.StateStack

const grammar = {
  tokenizeLine(line: string, stack: ShikiTextmate.StateStack) {
    const scopes = stack === ROOT ? ['root'] : ['root', 'heading']
    return {
      ruleStack: line.startsWith(HEADING) ? HEADING_OPEN : stack,
      stoppedEarly: false,
      tokens: [{ startIndex: 0, endIndex: line.length, scopes }]
    }
  }
} as unknown as Grammar

const textmate = { INITIAL: ROOT } as unknown as TextMateCore['textmate']

function tokenizeDocument(lines: readonly string[]): monaco.languages.ILineTokens[] {
  const provider = createTokensProvider({ textmate } as TextMateCore, grammar, SCOPE)
  let state = provider.getInitialState()
  return lines.map((line) => {
    const result = provider.tokenize(line, state)
    state = result.endState
    return result
  })
}

it('keeps highlighting the lines after one too long to tokenize', () => {
  const lines = ['# before', LONG, '# after', 'body']
  const [, long, after, body] = tokenizeDocument(lines)

  expect(long.tokens).toEqual([{ startIndex: 0, scopes: SCOPE }])
  expect(after.tokens).toEqual([{ startIndex: 0, scopes: 'heading' }])
  expect(body.tokens).toEqual([{ startIndex: 0, scopes: 'heading' }])
})
