import { describe, expect, it } from 'vitest'
import {
  findImportedPythonModule,
  findPythonDefinitionInText,
  resolvePythonDefinition,
  type PythonDefinitionHost
} from './python-definition-provider'

const source = [
  'import os',
  '',
  'def handler():',
  '    pass',
  '',
  'async def run_task():',
  '    pass',
  '',
  'class Widget:',
  '    pass'
].join('\n')

describe('findPythonDefinitionInText', () => {
  it('locates functions, async functions and classes', () => {
    expect(findPythonDefinitionInText(source, 'handler')).toEqual({ line: 3, column: 5 })
    expect(findPythonDefinitionInText(source, 'run_task')).toEqual({ line: 6, column: 11 })
    expect(findPythonDefinitionInText(source, 'Widget')).toEqual({ line: 9, column: 7 })
  })

  it('finds methods but not names inside strings', () => {
    expect(
      findPythonDefinitionInText('class A:\n    def method(self):\n        pass', 'method')
    ).toEqual({ line: 2, column: 9 })
    expect(findPythonDefinitionInText('x = "def fake():"', 'fake')).toBeNull()
  })
})

describe('findImportedPythonModule', () => {
  it('reads the module a symbol is imported from', () => {
    expect(findImportedPythonModule('from a.b import helper', 'helper')).toBe('a.b')
    expect(findImportedPythonModule('from a.b import other', 'helper')).toBeNull()
    expect(findImportedPythonModule('import a.b', 'helper')).toBeNull()
  })
})

function hostWith(
  searchResult: Awaited<ReturnType<PythonDefinitionHost['searchFiles']>>
): PythonDefinitionHost {
  return {
    searchFiles: async () => searchResult,
    readFile: async () => '',
    pathExists: async () => false,
    resolveWorkspace: () => ({
      worktreeId: 'worktree',
      runtimeEnvironmentId: null,
      rootPath: '/repo'
    }),
    openAndReveal: () => {}
  }
}

describe('resolvePythonDefinition', () => {
  it('prefers a definition in the current file', async () => {
    const target = await resolvePythonDefinition({
      text: source,
      name: 'handler',
      filePath: '/repo/app.py',
      host: hostWith({ files: [], totalMatches: 0, truncated: false })
    })
    expect(target).toEqual({ filePath: '/repo/app.py', line: 3, column: 5, sameFile: true })
  })

  it('falls back to a worktree search and reports the name column', async () => {
    const target = await resolvePythonDefinition({
      text: 'helper()',
      name: 'helper',
      filePath: '/repo/app.py',
      host: hostWith({
        files: [
          {
            filePath: '/repo/lib.py',
            relativePath: 'lib.py',
            matches: [{ line: 7, column: 1, matchLength: 9, lineContent: 'def helper():' }]
          }
        ],
        totalMatches: 1,
        truncated: false
      })
    })
    expect(target).toEqual({ filePath: '/repo/lib.py', line: 7, column: 5, sameFile: false })
  })

  it('gives up when the file is outside every workspace', async () => {
    const host = { ...hostWith({ files: [], totalMatches: 0, truncated: false }) }
    host.resolveWorkspace = () => null
    const target = await resolvePythonDefinition({
      text: 'helper()',
      name: 'helper',
      filePath: '/elsewhere/app.py',
      host
    })
    expect(target).toBeNull()
  })
})
