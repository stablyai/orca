import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parsePluginGrammarArtifact,
  type PluginGrammarArtifact
} from '../../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import {
  compilePluginGrammar,
  onigLibrary,
  tokenizePluginGrammarDocument
} from './plugin-grammar-tokenization'

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
  it('stops at a line too long to tokenize safely and leaves the rest plain', async () => {
    expect((await tokenize(`// ok\n${'x'.repeat(5000)}\n// after`))?.lines).toBe(1)
  })
})
