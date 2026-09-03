import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import type { IOnigLib } from 'vscode-textmate'
import { createTextMateTokensProvider } from './textmate-token-provider'
import type { TextMateGrammarLoader } from './textmate-token-provider'

const require = createRequire(import.meta.url)

let nodeOnigurumaPromise: Promise<IOnigLib> | undefined

// Why: loadWASM is process-global and throws on a second call, so callers share
// this promise. vitest isolates test files, so one memo per file is enough.
export async function loadNodeOniguruma(): Promise<IOnigLib> {
  nodeOnigurumaPromise ??= (async () => {
    const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm')
    const wasmBytes = await readFile(wasmPath)
    const wasmBuffer = wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength
    )
    await loadWASM(wasmBuffer)
    return { createOnigScanner, createOnigString }
  })()

  return nodeOnigurumaPromise
}

export type FixtureToken = { text: string; scope: string }

export type TokenizedFixture = {
  lines: string[]
  tokensByLine: FixtureToken[][]
  allTokens: FixtureToken[]
  /** Scopes for one more line tokenized with the state the fixture left behind. */
  trailingScopes: string[]
}

export type TokenizeFixtureOptions = {
  fixtureDir: string
  fixtureName: string
  scopeName: string
  loadGrammar: TextMateGrammarLoader
  trailingLine: string
}

export async function tokenizeFixture(options: TokenizeFixtureOptions): Promise<TokenizedFixture> {
  const provider = await createTextMateTokensProvider({
    scopeName: options.scopeName,
    loadGrammar: options.loadGrammar,
    loadOniguruma: loadNodeOniguruma
  })
  const lines = (await readFile(join(options.fixtureDir, options.fixtureName), 'utf8')).split('\n')

  // Why: carry state across every line the way the editor does. A grammar that
  // fails to close a nested comment only shows up on the lines that follow it.
  let state = provider.getInitialState()
  const tokensByLine = lines.map((line) => {
    const result = provider.tokenize(line, state)
    state = result.endState
    return result.tokens.map((token, index) => ({
      text: line.slice(token.startIndex, result.tokens[index + 1]?.startIndex ?? line.length),
      scope: token.scopes
    }))
  })

  return {
    lines,
    tokensByLine,
    allTokens: tokensByLine.flat(),
    // Why: the leftover state is what an editor carries into the rest of the
    // file, so one more line surfaces any comment or string left open.
    trailingScopes: provider.tokenize(options.trailingLine, state).tokens.map((t) => t.scopes)
  }
}

export type FixtureQueries = {
  /** Tokens of the single line containing `fragment`, optionally `lineOffset` below it. */
  lineWith: (fragment: string, lineOffset?: number) => FixtureToken[]
  scopesOf: (fragment: string, lineOffset?: number) => string[]
  /** Scope of the token equal to `text` on the line containing `fragment`. */
  scopeOnLine: (fragment: string, text: string) => string | undefined
  /** Scope shared by every token equal to `text` anywhere in the fixture. */
  uniqueScopeOf: (text: string) => string | undefined
}

export function createFixtureQueries(fixture: TokenizedFixture): FixtureQueries {
  function lineWith(fragment: string, lineOffset = 0): FixtureToken[] {
    // Why: the fragment must be unique as well as present — `let octa` also
    // matches `let octal`, which would assert against the wrong line.
    const matches = fixture.lines.filter((line) => line.includes(fragment))
    expect(matches, `fixture lines containing ${fragment}`).toHaveLength(1)
    return fixture.tokensByLine[fixture.lines.indexOf(matches[0]!) + lineOffset]!
  }

  return {
    lineWith,
    scopesOf: (fragment, lineOffset) => lineWith(fragment, lineOffset).map((t) => t.scope),
    scopeOnLine: (fragment, text) => lineWith(fragment).find((t) => t.text === text)?.scope,
    uniqueScopeOf: (text) => {
      const matches = fixture.allTokens.filter((token) => token.text === text)
      expect(matches, `fixture tokens equal to ${text}`).not.toHaveLength(0)
      expect(new Set(matches.map((t) => t.scope)), `scopes for ${text}`).toHaveLength(1)
      return matches[0]!.scope
    }
  }
}
