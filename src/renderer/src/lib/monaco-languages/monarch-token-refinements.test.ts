// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { TOKEN_REFINEMENT_LANGUAGES } from './monarch-token-refinement-languages'
import { pluginMonacoTokenRules } from '../editor/appearance/plugin-monaco-token-rules'
import { PLUGIN_SYNTAX_TOKEN_TYPES, pluginSyntaxTokenType } from './plugin-syntax-token-legend'
import { REFINED_TOKEN_SCOPES, withTokenRefinements } from './monarch-token-refinements'
import { tokenizeMonarchDocument, tokenTypeAt } from './monarch-tokenizer-test-harness'

async function controlLanguage(languageId: string) {
  const { load, ...spec } = TOKEN_REFINEMENT_LANGUAGES[languageId]
  return withTokenRefinements((await load()).language, spec)
}

/** The token type of each occurrence of `word` in `source`, without the language postfix. */
async function typesOf(languageId: string, source: string, word: string): Promise<string[]> {
  const lines = tokenizeMonarchDocument(languageId, await controlLanguage(languageId), source)
  return lines.flatMap((line) =>
    [
      ...line.text.matchAll(
        new RegExp(`(?<![\\w#@-])${word.replace(/[?#]/g, '\\$&')}(?![\\w?-])`, 'g')
      )
    ].map((match) => tokenTypeAt(line, match.index))
  )
}

// How each language reaches its keywords from a fresh file.
const CONTEXT: Record<string, (word: string) => string> = {
  php: (word) => `<?php ${word} $x;`,
  // Why: a bare `end` closes nothing, so it needs a block to close.
  ruby: (word) => (word === 'end' ? 'def f\nend' : `${word} x`)
}

describe('token refinements', () => {
  describe.each(
    Object.keys(TOKEN_REFINEMENT_LANGUAGES).filter(
      (id) => TOKEN_REFINEMENT_LANGUAGES[id].controlWords
    )
  )('%s', (languageId) => {
    const { controlWords } = TOKEN_REFINEMENT_LANGUAGES[languageId]
    const words = controlWords?.split(' ') ?? []
    it.each(words)('tokenizes `%s` as a control keyword', async (word) => {
      const source = (CONTEXT[languageId] ?? ((w: string) => `${w} x`))(word)
      expect(await typesOf(languageId, source, word)).toEqual([
        expect.stringMatching(/^keyword\.flow/)
      ])
    })
  })

  it.each([
    ['typescript', 'const x = 1', 'const', 'keyword'],
    ['typescript', 'typeof this', 'this', 'keyword'],
    ['python', 'def f(): pass', 'def', 'keyword'],
    ['go', 'func f() {}', 'func', 'keyword.func'],
    ['rust', 'let mut x = 1', 'let', 'keyword']
  ])('keeps %s `%s` a plain keyword', async (languageId, source, word, type) => {
    expect(await typesOf(languageId, source, word)).toEqual([type])
  })

  it('reads a keyword-named member after a lone `.` as a plain word', async () => {
    expect(await typesOf('typescript', 'const handler = promise.catch', 'catch')).toEqual([
      'identifier'
    ])
    expect(await typesOf('typescript', 'const f = Array.from', 'from')).toEqual(['identifier'])
    expect(await typesOf('javascript', 'a?.default', 'default')).toEqual(['identifier'])
    expect(await typesOf('python', 'm = re.match(p, s)', 'match')).toEqual(['identifier'])
    expect(await typesOf('ruby', 'self.class', 'class')).toEqual(['identifier'])
    expect(await typesOf('powershell', '$items.ForEach({ $_ })', 'ForEach')).toEqual([''])
  })

  it('keeps a member builtin its token, and control keywords after a spread or range', async () => {
    expect(await typesOf('ruby', 'jobs = Jobs.new(self)', 'new')).toEqual(['predefined'])
    expect(await typesOf('typescript', 'f(...this.args)', 'this')).toEqual(['keyword'])
    expect(await typesOf('python', 'from . import x', 'import')).toEqual(['keyword.flow'])
  })

  it('keeps state changes of the keywords it recolors', async () => {
    // Ruby's `if` modifier and block `end` drive its block states.
    const source = 'def f\n  return 1 if x\nend\nputs 1'
    expect(await typesOf('ruby', source, 'if')).toEqual(['keyword.flow.ifx'])
    expect(await typesOf('ruby', source, 'end')).toEqual(['keyword.flow.def'])
    expect(await typesOf('ruby', source, 'puts')).toEqual(['identifier'])
  })

  it('matches words with `#` exactly rather than as a substring', async () => {
    const source = '#import <Foundation/Foundation.h>\n- (void)a:(NSNotification *)n'
    expect(await typesOf('objective-c', source, '#import')).toEqual(['keyword.flow'])
    expect(await typesOf('objective-c', source, 'NSNotification')).toEqual(['identifier'])
  })

  it('recolors whole rules: preprocessor directives and CSS at-rules', async () => {
    expect(await typesOf('cpp', '#include <vector>', '#include')).toEqual([
      'keyword.flow.directive.include'
    ])
    expect(await typesOf('css', '@import url(base);', '@import')).toEqual(['keyword.flow'])
    expect(await typesOf('css', 'a { color: red !important; }', '!important')).toEqual(['keyword'])
  })

  it('recolors control words a language lists as builtins', async () => {
    expect(await typesOf('perl', 'return unless $x;', 'return')).toEqual(['keyword.flow'])
  })

  it('tokenizes a plain word right before `(` as a function, keyword-named members included', async () => {
    const source = 'promise.catch(f).finally (g); foo(); if (x) bar?.(1); a.b'
    expect(await typesOf('typescript', source, 'catch')).toEqual(['function'])
    expect(await typesOf('typescript', source, 'finally')).toEqual(['function'])
    expect(await typesOf('typescript', source, 'foo')).toEqual(['function'])
    expect(await typesOf('typescript', source, 'if')).toEqual(['keyword.flow'])
    expect(await typesOf('typescript', source, 'b')).toEqual(['identifier'])
    expect(await typesOf('go', 'func f() { fmt.Println(x) }', 'Println')).toEqual(['function'])
    expect(await typesOf('go', 'func f() { fmt.Println(x) }', 'f')).toEqual(['function'])
    expect(await typesOf('c', 'while (n) free(p);', 'free')).toEqual(['function'])
    expect(await typesOf('c', 'while (n) free(p);', 'while')).toEqual(['keyword.flow.while'])
  })

  it('leaves calls plain in languages whose grammar does not scope them', async () => {
    expect(await typesOf('python', 'run(x)', 'run')).toEqual(['identifier'])
  })

  it.each(Object.entries(REFINED_TOKEN_SCOPES))(
    'gives plugins `%s` through `%s`, as on plugin syntaxes',
    (token, scope) => {
      const rules = pluginMonacoTokenRules(
        [{ scope, settings: { foreground: '#123456' } }],
        (v) => v
      )
      expect(rules).toContainEqual(expect.objectContaining({ token, foreground: '#123456' }))
      expect(PLUGIN_SYNTAX_TOKEN_TYPES[pluginSyntaxTokenType([scope]) ?? -1]).toBe(token)
    }
  )
})
