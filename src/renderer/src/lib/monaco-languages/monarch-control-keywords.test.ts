// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { CONTROL_KEYWORD_LANGUAGES } from './monarch-control-keyword-languages'
import { withControlKeywords } from './monarch-control-keywords'
import { tokenizeMonarchDocument, tokenTypeAt } from './monarch-tokenizer-test-harness'

async function controlLanguage(languageId: string) {
  const { load, ...spec } = CONTROL_KEYWORD_LANGUAGES[languageId]
  return withControlKeywords((await load()).language, spec)
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

describe('control keywords', () => {
  describe.each(
    Object.keys(CONTROL_KEYWORD_LANGUAGES).filter((id) => CONTROL_KEYWORD_LANGUAGES[id].keywords)
  )('%s', (languageId) => {
    const { keywords } = CONTROL_KEYWORD_LANGUAGES[languageId]
    const words = keywords?.split(' ') ?? []
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
    expect(await typesOf('typescript', 'promise.catch(f).finally(g)', 'catch')).toEqual([
      'identifier'
    ])
    expect(await typesOf('typescript', 'Array.from(x)', 'from')).toEqual(['identifier'])
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
    expect(await typesOf('css', '@import url("a.css");', '@import')).toEqual(['keyword.flow'])
    expect(await typesOf('css', 'a { color: red !important; }', '!important')).toEqual(['keyword'])
  })

  it('recolors control words a language lists as builtins', async () => {
    expect(await typesOf('perl', 'return unless $x;', 'return')).toEqual(['keyword.flow'])
  })
})
