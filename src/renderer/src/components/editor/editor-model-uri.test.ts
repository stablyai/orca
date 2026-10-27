import { describe, expect, it } from 'vitest'
// The same module the public `monaco.Uri` re-exports, without loading the editor bundle.
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import { toEditorModelUri } from './editor-model-uri'

const paths = [
  '/repo/src/a.ts',
  'C:/repo/src/a.ts',
  'C:\\repo\\src\\a.ts',
  '\\\\server\\share\\a.ts',
  '//server/share/a.ts',
  'file:///C:/repo/src/a.ts',
  'file:///repo/src/a.ts',
  '/repo/src/a b.ts',
  '/repo/src/a%20b.ts',
  '/repo/src/a#b.ts',
  '\\\\wsl$\\Ubuntu\\home\\a.ts'
]

describe('toEditorModelUri', () => {
  it.each(paths)('yields the undo-preserving file scheme for %s', (path) => {
    expect(URI.parse(toEditorModelUri(path)).scheme).toBe('file')
  })

  // Model creation parses path strings and registry lookup uses toString; require round-trip stability so disposal finds the created model.
  it.each(paths)('round-trips through the Uri.parse the editor applies to %s', (path) => {
    const modelUri = toEditorModelUri(path)
    expect(URI.parse(modelUri).toString()).toBe(modelUri)
    expect(toEditorModelUri(modelUri)).toBe(modelUri)
  })

  it('collapses the drive-letter casing Windows treats as one file', () => {
    expect(toEditorModelUri('C:/repo/a.ts')).toBe(toEditorModelUri('c:/repo/a.ts'))
    expect(toEditorModelUri('file:///C:/repo/a.ts')).toBe(toEditorModelUri('C:/repo/a.ts'))
  })

  it('keeps distinct POSIX paths distinct', () => {
    expect(toEditorModelUri('/repo/a b.ts')).not.toBe(toEditorModelUri('/repo/a%20b.ts'))
  })

  it.each(paths)('keys an owner by authority and keeps the real path for %s', (path) => {
    const local = URI.parse(toEditorModelUri(path))
    const remoteUri = toEditorModelUri(path, '["hub-a","ssh:target#1"]')
    const remote = URI.parse(remoteUri)
    expect(remote.scheme).toBe('vscode-remote')
    // Move UNC servers into owned URI paths and tag authorities to retain their distinct identity.
    expect(remote.authority).toMatch(local.authority ? /^[0-9a-f]{16}-unc$/ : /^[0-9a-f]{16}$/)
    expect(remote.path).toBe(local.authority ? `/${local.authority}${local.path}` : local.path)
    expect(remote.path).not.toMatch(/^\/\//)
    expect(remote.fragment).toBe('')
    expect(remote.toString()).toBe(remoteUri)
    expect(toEditorModelUri(remoteUri)).toBe(remoteUri)
    expect(toEditorModelUri(path, '["hub-b","ssh:target#1"]')).not.toBe(remoteUri)
    expect(toEditorModelUri(remoteUri, '["hub-a","ssh:target#1"]')).toBe(remoteUri)
  })

  it('folds drive-letter case under an owner too', () => {
    const owner = '["hub-a","ssh:target"]'
    expect(toEditorModelUri('C:/repo/a.ts', owner)).toBe(toEditorModelUri('c:/repo/a.ts', owner))
  })

  it('keeps a UNC path apart from the same POSIX path under one owner', () => {
    const owner = '["hub-a","ssh:target"]'
    expect(toEditorModelUri('//server/share/a.ts', owner)).not.toBe(
      toEditorModelUri('/server/share/a.ts', owner)
    )
  })

  it('never collapses a real folder shaped like an owner', () => {
    const owner = '["hub-a","ssh:target"]'
    for (const realPath of ['/.orca-owner/0123456789abcdef/repo/a.ts', '/vscode-remote:/a.ts']) {
      expect(toEditorModelUri(realPath, owner)).not.toBe(toEditorModelUri('/repo/a.ts', owner))
      expect(URI.parse(toEditorModelUri(realPath, owner)).path).toBe(realPath)
    }
  })
})
