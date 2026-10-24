import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parsePluginGrammarArtifact,
  type PluginGrammarArtifact
} from '../../../../shared/plugins/plugin-syntax-artifact'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { isValidPluginGrammarTokens, type PluginGrammarTokens } from './plugin-grammar-protocol'
import {
  compilePluginGrammar,
  onigLibrary,
  tokenizePluginGrammarDocument
} from './plugin-grammar-tokenization'
import { PLUGIN_SYNTAX_TOKEN_TYPES } from './plugin-syntax-token-legend'

function lengths(text: string): number[] {
  return text.split('\n').map((line) => line.length)
}

/** The token names painted on a line, in order. */
function lineTypes(tokens: PluginGrammarTokens | null, line: number): string[] {
  const names: string[] = []
  for (let offset = 0; tokens && offset < tokens.data.length; offset += 4) {
    if (tokens.data[offset] === line) {
      names.push(PLUGIN_SYNTAX_TOKEN_TYPES[tokens.data[offset + 3] ?? 0])
    }
  }
  return names
}

const typst = parsePluginGrammarArtifact(
  readFileSync(join(__dirname, 'textmate-grammars', 'typst.tmLanguage.json'), 'utf8'),
  'source.typst'
)

async function compile(scopeName: string, grammars: PluginGrammarArtifact[]) {
  return compilePluginGrammar(scopeName, grammars, onigLibrary(await loadNodeOniguruma()))
}

async function tokenize(text: string, cancelled = () => false) {
  const compiled = await compile('source.typst', [typst])
  if (!compiled) {
    throw new Error('typst grammar did not compile')
  }
  try {
    return await tokenizePluginGrammarDocument(compiled.grammar, text, {
      progress: () => {},
      cancelled,
      yieldSlice: async () => {}
    })
  } finally {
    compiled.dispose()
  }
}

// These run the real Oniguruma engine. A catastrophic regex is cut off by its retry limit within
// ~100 ms, so the worker's 2 s stall timer guards engine hangs and crashes; that path is covered
// with a fake worker in plugin-grammar-worker-client.test.ts.
describe('plugin grammar tokenization (real engine)', () => {
  it('tokenizes a real-world grammar into valid, scope-named tokens', async () => {
    const text = '= Heading\n// a comment\n#let x = "hello"\n'
    const tokens = await tokenize(text)
    expect(
      tokens && isValidPluginGrammarTokens(tokens, lengths(text), PLUGIN_SYNTAX_TOKEN_TYPES.length)
    ).toBe(true)
    expect(tokens?.lines).toBe(4)
    // The comment marker and the string's quotes take their enclosing color.
    expect(lineTypes(tokens, 1)).toEqual(['comment'])
    expect(lineTypes(tokens, 2)).toContain('string')
  })

  it('stops at a line too long to tokenize safely and leaves the rest plain', async () => {
    expect((await tokenize(`// ok\n${'x'.repeat(5000)}\n// after`))?.lines).toBe(1)
  })

  it('stops between slices when cancelled, and refuses huge documents', async () => {
    expect(await tokenize('// a\n'.repeat(3000), () => true)).toBeNull()
    expect(await tokenize('x\n'.repeat(25_000))).toBeNull()
  })

  it('leaves an embedded outside scope plain instead of failing the grammar', async () => {
    const demo = parsePluginGrammarArtifact(
      JSON.stringify({
        scopeName: 'source.demo',
        patterns: [
          { begin: '<js>', end: '</js>', patterns: [{ include: 'source.js' }] },
          { match: '#.*', name: 'comment.line.demo' }
        ]
      }),
      'source.demo'
    )
    const compiled = await compile('source.demo', [demo])
    expect(compiled).not.toBeNull()
    const tokens = compiled
      ? await tokenizePluginGrammarDocument(compiled.grammar, '<js>let a</js>\n# note', {
          progress: () => {},
          cancelled: () => false
        })
      : null
    expect(lineTypes(tokens, 1)).toEqual(['comment'])
    compiled?.dispose()
    expect(await compile('source.missing', [demo])).toBeNull()
  })
})
