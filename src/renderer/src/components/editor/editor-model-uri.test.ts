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
  '/repo/src/a#b.ts'
]

describe('toEditorModelUri', () => {
  it.each(paths)('yields the undo-preserving file scheme for %s', (path) => {
    expect(URI.parse(toEditorModelUri(path)).scheme).toBe('file')
  })

  // Monaco keys its model registry by `uri.toString()`, and `@monaco-editor/react` builds the model
  // by calling `Uri.parse` on the `path` prop — so the key a disposal lookup computes only matches
  // the created model if the helper's output survives that parse unchanged.
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
})
