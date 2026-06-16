import { describe, expect, it } from 'vitest'
import { grammarForPath, PROVIDER_LANGUAGE_IDS, resolvesTogether } from './language-registry'

describe('tree-sitter language registry', () => {
  it('maps file extensions to the right grammar', () => {
    expect(grammarForPath('src/a.ts')).toBe('typescript')
    expect(grammarForPath('src/a.mts')).toBe('typescript')
    expect(grammarForPath('src/Comp.tsx')).toBe('tsx')
    expect(grammarForPath('src/a.js')).toBe('javascript')
    expect(grammarForPath('src/a.jsx')).toBe('javascript')
    expect(grammarForPath('m.py')).toBe('python')
    expect(grammarForPath('main.go')).toBe('go')
    expect(grammarForPath('lib.rs')).toBe('rust')
    expect(grammarForPath('A.java')).toBe('java')
    expect(grammarForPath('P.cs')).toBe('c-sharp')
    expect(grammarForPath('u.cpp')).toBe('cpp')
    expect(grammarForPath('u.h')).toBe('cpp')
    expect(grammarForPath('s.rb')).toBe('ruby')
    expect(grammarForPath('i.php')).toBe('php')
    expect(grammarForPath('deploy.sh')).toBe('bash')
  })

  it('is case-insensitive and handles Windows paths', () => {
    expect(grammarForPath('C:\\repo\\Main.GO')).toBe('go')
    expect(grammarForPath('SRC\\TOP.PY')).toBe('python')
  })

  it('returns null for unsupported or extension-less paths', () => {
    expect(grammarForPath('notes.md')).toBeNull()
    expect(grammarForPath('data.json')).toBeNull()
    expect(grammarForPath('Makefile')).toBeNull()
  })

  it('registers the provider for every supported Monaco language id', () => {
    for (const id of [
      'typescript',
      'javascript',
      'python',
      'go',
      'rust',
      'java',
      'csharp',
      'cpp',
      'c',
      'ruby',
      'php',
      'shell'
    ]) {
      expect(PROVIDER_LANGUAGE_IDS).toContain(id)
    }
  })

  it('treats TS/TSX/JS as one resolution family but isolates other languages', () => {
    expect(resolvesTogether('tsx', 'typescript')).toBe(true)
    expect(resolvesTogether('javascript', 'typescript')).toBe(true)
    expect(resolvesTogether('typescript', 'python')).toBe(false)
    expect(resolvesTogether('python', 'python')).toBe(true)
    expect(resolvesTogether('go', 'cpp')).toBe(false)
  })
})
