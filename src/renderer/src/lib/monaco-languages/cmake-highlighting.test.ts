// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { monaco } from '../monaco-setup'
import { detectLanguage } from '../../../../shared/editor-language/editor-language-detect'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

it('highlights CMakeLists.txt with token types the stock Monaco themes style', async () => {
  const language = detectLanguage('CMakeLists.txt')
  expect(language).toBe('cmake')
  const lines = [
    'cmake_minimum_required(VERSION 3.20) # build',
    'target_link_libraries(app PUBLIC ${DEPS} "a\\"#b")',
    'set(DOC [[ #raw ]])'
  ]
  const source = lines.join('\n')
  await monaco.editor.colorize(source, language, {})
  const tokens = monaco.editor.tokenize(source, language)
  const typeOf = (line: number, text: string): string | undefined =>
    tokens[line].findLast((token) => token.offset <= lines[line].indexOf(text))?.type

  expect(typeOf(0, 'cmake_minimum_required')).toBe('keyword.cmake')
  expect(typeOf(0, '# build')).toBe('comment.source.cmake')
  expect(typeOf(1, 'PUBLIC')).toBe('type.cmake')
  expect(typeOf(1, '${DEPS}')).toBe('variable.cmake')
  expect(typeOf(1, '\\"')).toBe('string.escape.cmake')
  expect(typeOf(1, '#b')).toBe('string.source.cmake')
  expect(typeOf(2, '[[')).toBe('string.cmake')
})
