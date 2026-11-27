import { describe, expect, it } from 'vitest'
import { normalizeNewFileExtension } from './new-file-extension-picker-request'

describe('normalizeNewFileExtension', () => {
  it('accepts bare, dotted, and compound extensions', () => {
    expect(normalizeNewFileExtension('ts')).toBe('.ts')
    expect(normalizeNewFileExtension('.js')).toBe('.js')
    expect(normalizeNewFileExtension('  d.ts  ')).toBe('.d.ts')
    expect(normalizeNewFileExtension('.excalidraw.json')).toBe('.excalidraw.json')
    expect(normalizeNewFileExtension('c++')).toBe('.c++')
  })

  it('rejects empty, traversal, separator, and Windows-illegal inputs', () => {
    expect(normalizeNewFileExtension('')).toBeNull()
    expect(normalizeNewFileExtension('   ')).toBeNull()
    expect(normalizeNewFileExtension('.')).toBeNull()
    expect(normalizeNewFileExtension('..')).toBeNull()
    expect(normalizeNewFileExtension('../ts')).toBeNull()
    expect(normalizeNewFileExtension('a/b')).toBeNull()
    expect(normalizeNewFileExtension('a\\b')).toBeNull()
    expect(normalizeNewFileExtension('ts?')).toBeNull()
    expect(normalizeNewFileExtension('a..b')).toBeNull()
    expect(normalizeNewFileExtension('ts js')).toBeNull()
    expect(normalizeNewFileExtension('a'.repeat(64))).toBeNull()
  })
})
