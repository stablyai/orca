// @vitest-environment happy-dom
import type * as Monaco from 'monaco-editor'
import { language as javascript } from 'monaco-editor/esm/vs/basic-languages/javascript/javascript.js'
import { language as typescript } from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js'
import { describe, expect, it } from 'vitest'
import { tokenizeMonarchDocument, tokenTypeAt } from './monarch-tokenizer-test-harness'
import { withControlKeywords } from './register-control-keywords'

const SOURCE = "import { a } from 'a'; export const b = () => { return a as T }"

function keywordTypes(languageId: string, language: Monaco.languages.IMonarchLanguage) {
  const [line] = tokenizeMonarchDocument(languageId, withControlKeywords(language), SOURCE)
  return ['import', 'from', 'export', 'const', 'return'].map((word) => [
    word,
    tokenTypeAt(line, SOURCE.indexOf(word))
  ])
}

const EXPECTED = [
  ['import', 'keyword.flow'],
  ['from', 'keyword.flow'],
  ['export', 'keyword.flow'],
  ['const', 'keyword'],
  ['return', 'keyword.flow']
]

describe('control keyword tokenization', () => {
  it('splits TypeScript control keywords from declaration keywords', () => {
    expect(keywordTypes('typescript', typescript)).toEqual(EXPECTED)
  })

  it('splits JavaScript control keywords from declaration keywords', () => {
    expect(keywordTypes('javascript', javascript)).toEqual(EXPECTED)
  })
})
