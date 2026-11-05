// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { loadNodeOniguruma } from '../syntax-highlighting/oniguruma-test-harness'
import { monaco } from '../monaco-setup'
import { detectLanguage } from '../../../../shared/editor-language/editor-language-detect'

vi.mock('../syntax-highlighting/oniguruma', () => ({ loadOniguruma: loadNodeOniguruma }))

describe('Just highlighting through production Monaco setup', () => {
  it.each(['Justfile', 'justfile', '.justfile', 'recipes.just'])(
    'recognizes and highlights %s',
    async (filename) => {
      const language = detectLanguage(filename)
      expect(language).toBe('just')
      const source = [
        '# build the image',
        'export FOO := "bar"',
        'default: build',
        'build target="debug":',
        '    docker build -t app {{target}}'
      ].join('\n')
      await monaco.editor.colorize(source, language, {})
      const tokens = monaco.editor.tokenize(source, language)
      const types = tokens.map((line) => line.map((token) => token.type))
      expect(types[0]).toEqual(['comment.line.number-sign.just'])
      expect(types[1]).toEqual(
        expect.arrayContaining([
          'keyword.other.reserved.just',
          'variable.other.just',
          'keyword.operator.assignment.just',
          'string.quoted.double.just'
        ])
      )
      expect(types[2]).toEqual(
        expect.arrayContaining(['entity.name.function.just', 'keyword.operator.recipe.end.just'])
      )
      expect(types[3]).toEqual(
        expect.arrayContaining(['entity.name.function.just', 'string.quoted.double.just'])
      )
    }
  )
})
