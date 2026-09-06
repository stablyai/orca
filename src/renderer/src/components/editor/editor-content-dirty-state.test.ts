import { describe, expect, it } from 'vitest'
import { isEditorContentUnchanged } from './editor-content-dirty-state'

// Why: the exact expression the editor used before, kept as the equivalence oracle.
function referenceUnchanged(
  content: string,
  original: string,
  ignoreTrailingWhitespace: boolean
): boolean {
  const normalize = ignoreTrailingWhitespace
    ? (value: string): string => value.trimEnd()
    : (value: string): string => value
  return normalize(content) === normalize(original)
}

const SAMPLES = [
  '',
  ' ',
  '\n',
  '\n\n',
  '  \t\n',
  '# Title',
  '# Title\n',
  '# Title\n\n',
  '# Title \n',
  '# Titl',
  '# Titles',
  '# Title\r\n',
  '# Title\r\n\r\n',
  '# Title ',
  '# Title ',
  '# Title　',
  'a'.repeat(2_000),
  `${'a'.repeat(2_000)}\n`,
  `${'a'.repeat(1_999)}b`
]

describe('isEditorContentUnchanged', () => {
  it('matches the trimEnd comparison for every pair in the corpus', () => {
    for (const content of SAMPLES) {
      for (const original of SAMPLES) {
        for (const ignoreTrailingWhitespace of [false, true]) {
          expect({
            content,
            original,
            ignoreTrailingWhitespace,
            result: isEditorContentUnchanged(content, original, ignoreTrailingWhitespace)
          }).toEqual({
            content,
            original,
            ignoreTrailingWhitespace,
            result: referenceUnchanged(content, original, ignoreTrailingWhitespace)
          })
        }
      }
    }
  })

  it('treats markdown trailing whitespace as insignificant', () => {
    expect(isEditorContentUnchanged('# Title\n\n\n', '# Title\n', true)).toBe(true)
    expect(isEditorContentUnchanged('# Title\n\n\n', '# Title\n', false)).toBe(false)
  })

  it('detects a same-length edit', () => {
    expect(isEditorContentUnchanged('# Titlf\n', '# Title\n', true)).toBe(false)
  })

  it('reports unchanged again after an edit is undone back to the original', () => {
    const original = '# Notes\n\nBody text.\n'
    expect(isEditorContentUnchanged(original, original, true)).toBe(true)
    expect(isEditorContentUnchanged(`${original}x`, original, true)).toBe(false)
    expect(isEditorContentUnchanged(original, original, true)).toBe(true)
  })
})
