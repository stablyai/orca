import { describe, expect, it } from 'vitest'
import {
  configSearchDirectories,
  findImportSpecifierAt,
  importCandidatePaths,
  parseModuleResolutionConfig
} from './import-specifier-resolution'

describe('findImportSpecifierAt', () => {
  const line = "import { getStorageItem } from 'helpers/localStorage';"

  it('finds the specifier under the cursor', () => {
    expect(findImportSpecifierAt(line, line.indexOf('helpers') + 3)).toEqual({
      specifier: 'helpers/localStorage',
      startColumn: 32,
      endColumn: 53
    })
  })

  it('ignores clicks outside the quoted path', () => {
    expect(findImportSpecifierAt(line, line.indexOf('getStorageItem') + 1)).toBeNull()
  })

  it('finds dynamic imports and requires', () => {
    expect(findImportSpecifierAt("const a = import('./a')", 20)?.specifier).toBe('./a')
    expect(findImportSpecifierAt("const b = require('../b')", 21)?.specifier).toBe('../b')
  })
})

describe('importCandidatePaths', () => {
  it('resolves relative specifiers against the source folder', () => {
    const candidates = importCandidatePaths(
      '../interfaces/layout.interface',
      '/repo/src/pages/helpers/storage.ts',
      null
    )
    expect(candidates[0]).toBe('/repo/src/pages/interfaces/layout.interface')
    expect(candidates).toContain('/repo/src/pages/interfaces/layout.interface.ts')
    expect(candidates).toContain('/repo/src/pages/interfaces/layout.interface/index.tsx')
  })

  it('maps tsconfig paths relative to the config folder without baseUrl', () => {
    const config = parseModuleResolutionConfig(
      `{
        // comment
        "compilerOptions": { "paths": { "helpers/*": ["./src/helpers/*"], }, },
      }`,
      '/repo'
    )
    expect(importCandidatePaths('helpers/a/b', '/repo/src/x.ts', config)).toContain(
      '/repo/src/helpers/a/b.ts'
    )
  })

  it('maps through baseUrl', () => {
    const config = parseModuleResolutionConfig('{"compilerOptions":{"baseUrl":"src"}}', '/repo')
    expect(importCandidatePaths('utils/date', '/repo/src/x.ts', config)).toContain(
      '/repo/src/utils/date.ts'
    )
  })

  it('leaves bare package imports unresolved without a mapping', () => {
    expect(importCandidatePaths('react', '/repo/src/x.ts', null)).toEqual([])
  })
})

describe('configSearchDirectories', () => {
  it('walks from the file folder up to the root', () => {
    expect(configSearchDirectories('/repo/src/a/b.ts', '/repo')).toEqual([
      '/repo/src/a',
      '/repo/src',
      '/repo'
    ])
  })
})
