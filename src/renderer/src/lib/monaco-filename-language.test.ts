import { describe, expect, it } from 'vitest'
import { detectLanguage } from './language-detect'
import { detectMonacoFilenameLanguage } from './monaco-filename-language'
import associations from './monaco-language-associations.json'

describe('Monaco filename detection', () => {
  it.each([
    ['contracts/Vault.sol', 'sol'],
    ['infra/main.bicep', 'bicep'],
    ['queries/query.cypher', 'cypher'],
    ['scripts/run.fsx', 'fsharp'],
    ['shaders/main.wgsl', 'wgsl'],
    ['docs/guide.rst', 'restructuredtext'],
    ['C:\\workspace\\main.TcPOU', 'st'],
    ['\\\\host\\share\\main.ML', 'fsharp'],
    ['/remote/folder workspace/main.pas', 'pascal'],
    ['templates/page.ftl', 'freemarker2'],
    ['config/.babelrc', 'json'],
    ['Gemfile', 'ruby'],
    ['include/header.hxx', 'cpp'],
    ['script.es6', 'javascript'],
    ['script.pp', 'ruby']
  ])('detects %s using built-in metadata', (path, language) => {
    expect(detectLanguage(path)).toBe(language)
  })

  it('recognizes every unambiguous upstream extension and filename', () => {
    for (const language of associations) {
      for (const extension of language.extensions) {
        const owners = associations.filter((entry) =>
          entry.extensions.some((candidate) => candidate.toLowerCase() === extension.toLowerCase())
        )
        if (owners.length === 1) {
          expect(detectMonacoFilenameLanguage(`sample${extension}`)).toBe(language.id)
        }
      }
      for (const filename of language.filenames) {
        expect(detectMonacoFilenameLanguage(filename)).toBe(language.id)
      }
    }
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
    ['.env.staging', 'ini'],
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
