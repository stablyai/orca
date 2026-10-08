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

  it.each([
    'lib/tasks/devise.rake',
    'config.ru',
    'app/views/posts/index.json.jbuilder',
    'lib/tasks/install.thor',
    'rails/Guardfile',
    'deploy/Capfile',
    'ios/Podfile',
    'homebrew/Brewfile',
    'vms/Vagrantfile',
    'C:\\repo\\lib\\tasks\\DEVISE.RAKE',
    'C:\\repo\\CONFIG.RU',
    'C:\\repo\\INDEX.JSON.JBUILDER',
    'C:\\repo\\INSTALL.THOR',
    'C:\\vms\\VAGRANTFILE',
    '/home/user/folder workspace/tasks/Daily.RaKe',
    'main.rb',
    'main.rbx',
    'main.rjs',
    'package.gemspec',
    'script.pp',
    'Rakefile',
    'Gemfile'
  ])('recognizes Ruby source %s', (path) => {
    expect(detectLanguage(path)).toBe('ruby')
    expect(detectMonacoFilenameLanguage(path.split(/[\\/]/).at(-1)!)).toBe('ruby')
  })

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
