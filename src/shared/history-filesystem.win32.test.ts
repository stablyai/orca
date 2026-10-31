import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHistoryFilesystem } from './history-filesystem'

describe.skipIf(process.platform !== 'win32')('actual Windows directory capabilities', () => {
  it('creates junctions without symlink privilege and consumes opaque entries without their referents', () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-history-junction-'))
    const binding = loadHistoryFilesystem()
    let root
    try {
      root = binding.openDirectory(path, false)
      mkdirSync(join(path, 'store'))
      writeFileSync(join(path, 'store', 'keep'), 'untouched')
      // Setup passes the namespaced form; the junction still reads back as the plain path.
      root.link('view', toNamespacedPath(join(path, 'store')))
      expect(root.readLink('view')).toBe(join(path, 'store'))
      expect(lstatSync(join(path, 'view')).isSymbolicLink()).toBe(true)
      expect(root.kind('view')).toBe('link')
      expect(() => root.open('view')).toThrow()
      expect(() => root.move('view', root!, 'not-a-directory', true)).toThrow()
      expect(root.move('view', root, 'pending')).toBe('moved')
      expect(root.move('pending', root, 'view')).toBe('moved')
      expect(readFileSync(join(path, 'store', 'keep'), 'utf8')).toBe('untouched')
      expect(() => root.link('view', join(path, 'store'))).toThrow()
    } finally {
      root?.close()
      rmSync(path, { recursive: true, force: true })
    }
  })
})
