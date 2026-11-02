// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { monaco } from '../monaco-setup'
import { detectLanguage } from '../../../../shared/editor-language/editor-language-detect'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

it('highlights a Jenkinsfile with token types the stock Monaco themes style', async () => {
  const language = detectLanguage('ci/Jenkinsfile')
  const lines = [
    "@Library('shared') _",
    'def count = 42 // build',
    'sh "make ${params.TARGET}"',
    'env.OK = count instanceof Integer'
  ]
  const source = lines.join('\n')
  await monaco.editor.colorize(source, language, {})
  const tokens = monaco.editor.tokenize(source, language)
  const typeAt = (line: number, column: number): string | undefined =>
    tokens[line].findLast((token) => token.offset <= column)?.type
  const typeOf = (line: number, text: string) => typeAt(line, lines[line].indexOf(text))

  expect(typeOf(0, '@Library')).toBe('annotation.groovy')
  expect(typeOf(0, "'")).toBe('string.quoted.single.groovy')
  expect(typeOf(1, 'def')).toBe('keyword.groovy')
  expect(typeOf(1, '42')).toBe('number.groovy')
  expect(typeOf(1, '//')).toBe('comment.line.double-slash.groovy')
  expect(typeOf(2, '"')).toBe('string.quoted.double.groovy')
  expect(typeOf(2, 'params')).toBe('source.groovy')
  expect(typeAt(2, lines[2].length - 1)).toBe('string.quoted.double.groovy')
  expect(typeOf(3, '.')).toBe('source.groovy')
  expect(typeOf(3, '=')).toBe('source.groovy')
  expect(typeOf(3, 'instanceof')).toBe('keyword.operator.instanceof.groovy')
})
