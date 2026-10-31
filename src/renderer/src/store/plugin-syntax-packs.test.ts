import { describe, expect, it } from 'vitest'
import type { PluginSyntaxMetadata } from '../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { detectLanguage } from '../../../shared/editor-language/editor-language-detect'
import { resolvePluginSyntaxForFile } from './plugin-syntax-packs'

function syntax(id: string, extensions: string[], filenames: string[] = []): PluginSyntaxMetadata {
  return {
    id: `plugin:${id}`,
    pluginKey: id,
    label: id,
    extensions,
    filenames,
    revision: 'r1'
  }
}

function resolve(entries: PluginSyntaxMetadata[], filePath: string): string | null {
  return resolvePluginSyntaxForFile(entries, filePath, detectLanguage(filePath))?.id ?? null
}

describe('resolvePluginSyntaxForFile', () => {
  it('lets a plugin replace guessed core mappings for extensions it claims', () => {
    const entries = [
      syntax('matlab', ['.m']),
      syntax('ocaml', ['.ml', '.mli']),
      syntax('julia', ['.jl']),
      syntax('jsp', ['.jsp', '.jspf'])
    ]
    expect(detectLanguage('/repo/solve.m')).toBe('objective-c')
    expect(resolve(entries, '/repo/solve.m')).toBe('plugin:matlab')
    expect(resolve(entries, '/repo/main.ml')).toBe('plugin:ocaml')
    expect(resolve(entries, '/repo/main.mli')).toBe('plugin:ocaml')
    expect(resolve(entries, '/repo/run.jl')).toBe('plugin:julia')
    expect(resolve(entries, 'C:\\repo\\INDEX.JSP')).toBe('plugin:jsp')
  })

  it('lets a plugin color languages Orca maps but never registers a grammar for', () => {
    const entries = [syntax('haskell', ['.hs']), syntax('erlang', ['.erl', '.hrl'])]
    expect(resolve(entries, '/repo/Main.hs')).toBe('plugin:haskell')
    expect(resolve(entries, '/repo/app.erl')).toBe('plugin:erlang')
    expect(resolve(entries, '/repo/app.hrl')).toBe('plugin:erlang')
  })

  it('keeps Orca languages with language services or Markdown features', () => {
    const entries = [syntax('greedy', ['.ts', '.js', '.json', '.css', '.html', '.md'])]
    for (const file of ['a.ts', 'a.js', 'a.json', 'a.css', 'a.html', 'a.md']) {
      expect(resolve(entries, `/repo/${file}`)).toBeNull()
    }
  })

  it('keeps existing behavior when no plugin claims the file', () => {
    const entries = [syntax('matlab', ['.m'])]
    expect(resolve(entries, '/repo/main.ml')).toBeNull()
    expect(resolve([], '/repo/solve.m')).toBeNull()
    expect(resolve(entries, '/repo/notes.txt')).toBeNull()
  })

  it('picks the same winner when two plugins claim a file, whatever their load order', () => {
    const a = syntax('a-matlab', ['.m'])
    const b = syntax('b-matlab', ['.m'])
    expect(resolve([b, a], '/repo/solve.m')).toBe('plugin:a-matlab')
    expect(resolve([a, b], '/repo/solve.m')).toBe('plugin:a-matlab')
    const byName = syntax('z-name', [], ['solve.m'])
    expect(resolve([a, byName], '/repo/solve.m')).toBe('plugin:z-name')
  })
})
