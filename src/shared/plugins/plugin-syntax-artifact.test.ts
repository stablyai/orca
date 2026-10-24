import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parsePluginGrammarArtifact,
  parsePluginLanguageConfiguration,
  parsePluginSyntaxPayload,
  validatePluginGrammarIncludes
} from './plugin-syntax-artifact'

const typstGrammar = readFileSync(
  join(
    process.cwd(),
    'src/renderer/src/lib/monaco-languages/textmate-grammars/typst.tmLanguage.json'
  ),
  'utf8'
)

function grammar(scopeName: string, body: Record<string, unknown> = {}): string {
  return JSON.stringify({ scopeName, patterns: [], ...body })
}

describe('plugin syntax artifacts', () => {
  it('accepts a real-world grammar and drops keys the engine does not use', () => {
    const parsed = parsePluginGrammarArtifact(typstGrammar, 'source.typst')
    expect(parsed.patterns.length).toBeGreaterThan(0)
    expect(Object.keys(parsed.repository).length).toBeGreaterThan(5)
    expect(
      parsePluginGrammarArtifact(
        grammar('source.demo', { injectionSelector: 'L:x' }),
        'source.demo'
      )
    ).not.toHaveProperty('injectionSelector')
  })

  it('refuses a grammar whose scope differs from its declaration', () => {
    expect(() => parsePluginGrammarArtifact(grammar('source.other'), 'source.demo')).toThrow(
      'does not match'
    )
  })

  it('refuses oversized and deeply nested grammars', () => {
    const huge = grammar('source.demo', { comment: 'x'.repeat(1024 * 1024) })
    expect(() => parsePluginGrammarArtifact(huge, 'source.demo')).toThrow('exceeds')
    let nested: Record<string, unknown> = { match: 'a' }
    for (let depth = 0; depth < 80; depth += 1) {
      nested = { patterns: [nested] }
    }
    expect(() =>
      parsePluginGrammarArtifact(grammar('source.demo', { patterns: [nested] }), 'source.demo')
    ).toThrow('nested too deeply')
  })

  it('requires includes inside the plugin to resolve and lets outside scopes degrade', () => {
    const main = parsePluginGrammarArtifact(
      grammar('source.demo', {
        patterns: [
          { include: '#local' },
          { include: 'source.demo.embedded#value' },
          { include: 'source.js' }
        ],
        repository: {
          local: {
            match: 'x',
            repository: { inner: { match: 'y' } },
            patterns: [{ include: '#inner' }]
          }
        }
      }),
      'source.demo'
    )
    const embedded = parsePluginGrammarArtifact(
      grammar('source.demo.embedded', { repository: { value: { match: 'y' } } }),
      'source.demo.embedded'
    )
    expect(() => validatePluginGrammarIncludes([main, embedded])).not.toThrow()
    const missingKey = parsePluginGrammarArtifact(
      grammar('source.demo', { patterns: [{ include: 'source.demo.embedded#nope' }] }),
      'source.demo'
    )
    expect(() => validatePluginGrammarIncludes([missingKey, embedded])).toThrow('does not resolve')
    const missingLocal = parsePluginGrammarArtifact(
      grammar('source.demo', { patterns: [{ include: '#absent' }] }),
      'source.demo'
    )
    expect(() => validatePluginGrammarIncludes([missingLocal])).toThrow('does not resolve')
  })

  it('checks a large grammar in linear time', () => {
    const repository = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [
        `rule${index}`,
        { patterns: Array.from({ length: 20 }, () => ({ include: `#rule${(index + 1) % 2_000}` })) }
      ])
    )
    const large = parsePluginGrammarArtifact(
      JSON.stringify({ scopeName: 'source.big', patterns: [{ include: '#rule0' }], repository }),
      'source.big'
    )
    const started = performance.now()
    validatePluginGrammarIncludes([large])
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('bounds language configuration and validates payloads at renderer ingress', () => {
    expect(
      parsePluginLanguageConfiguration(
        JSON.stringify({ comments: { lineComment: '//' }, brackets: [['{', '}']] })
      )
    ).toEqual({ comments: { lineComment: '//' }, brackets: [['{', '}']] })
    expect(() =>
      parsePluginLanguageConfiguration(JSON.stringify({ brackets: [['', '}']] }))
    ).toThrow()
    const payload = {
      id: 'plugin:samples.demo/demo',
      revision: 'abc',
      scopeName: 'source.demo',
      grammars: [{ scopeName: 'source.demo', patterns: [], repository: {} }],
      configuration: {}
    }
    expect(parsePluginSyntaxPayload(payload)).toEqual(payload)
    expect(parsePluginSyntaxPayload({ ...payload, grammars: [] })).toBeNull()
  })
})
