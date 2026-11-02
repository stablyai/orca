import { describe, expect, it } from 'vitest'
import { detectLanguage } from './editor-language-detect'

describe('Monaco filename detection', () => {
  it.each([
    'report.rake.bak',
    'ruby.rakex',
    'Guardfile.bak',
    'Guardfilex',
    'tasks.rake/README',
    'tasks.rake\\README'
  ])('keeps non-Ruby file %s on plaintext', (path) => {
    expect(detectLanguage(path)).toBe('plaintext')
  })

  it.each([
    ['file.mdx', 'markdown'],
    ['file.tsx', 'typescript'],
    ['file.jsonl', 'jsonl'],
    ['file.ipynb', 'notebook'],
    ['file.vue', 'vue'],
    ['file.svelte', 'svelte'],
    ['file.astro', 'astro'],
    ['file.typ', 'typst'],
    ['file.nim', 'nim'],
    ['file.h', 'c'],
    ['.env.staging', 'dotenv'],
    ['file.unknown', 'plaintext'],
    ['folder.sol/README', 'plaintext'],
    ['folder.sol\\README', 'plaintext'],
    ['constructor', 'plaintext'],
    ['toString', 'plaintext'],
    ['__proto__', 'plaintext']
  ])('preserves Orca behavior for %s', (path, language) => {
    expect(detectLanguage(path)).toBe(language)
  })
})
