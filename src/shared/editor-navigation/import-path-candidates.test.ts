import { describe, expect, it } from 'vitest'
import {
  aliasModulePaths,
  importFileCandidates,
  parseCompilerConfig
} from './import-path-candidates'

describe('import path candidates', () => {
  it('tries source extensions before index files', () => {
    expect(importFileCandidates('/repo/src/api')).toEqual([
      '/repo/src/api.ts',
      '/repo/src/api.tsx',
      '/repo/src/api.d.ts',
      '/repo/src/api.js',
      '/repo/src/api.jsx',
      '/repo/src/api.mts',
      '/repo/src/api.cts',
      '/repo/src/api.mjs',
      '/repo/src/api.cjs',
      '/repo/src/api.json',
      '/repo/src/api/index.ts',
      '/repo/src/api/index.tsx',
      '/repo/src/api/index.d.ts',
      '/repo/src/api/index.js',
      '/repo/src/api/index.jsx',
      '/repo/src/api/index.mts',
      '/repo/src/api/index.cts',
      '/repo/src/api/index.mjs',
      '/repo/src/api/index.cjs',
      '/repo/src/api/index.json'
    ])
  })

  it('maps an emitted .js specifier back to its TypeScript source first', () => {
    expect(importFileCandidates('/repo/src/calc.js').slice(0, 4)).toEqual([
      '/repo/src/calc.ts',
      '/repo/src/calc.tsx',
      '/repo/src/calc.d.ts',
      '/repo/src/calc.js'
    ])
  })

  it('resolves a paths alias against baseUrl, preferring the longest prefix', () => {
    const config = {
      baseDirectory: '/repo',
      paths: { '@/*': ['src/*'], '@/lib/*': ['packages/lib/src/*'] }
    }
    expect(aliasModulePaths('@/lib/files/drop', config)[0]).toBe(
      '/repo/packages/lib/src/files/drop'
    )
  })

  it('prefers an exact paths pattern over a wildcard with the same prefix', () => {
    const config = { pathsDirectory: '/repo', paths: { 'foo*': ['wild/*'], foo: ['exact.ts'] } }
    expect(aliasModulePaths('foo', config)).toEqual(['/repo/exact.ts'])
  })

  it('resolves paths against the declaring config when there is no baseUrl', () => {
    const config = { pathsDirectory: '/repo/app', paths: { '@/*': ['./src/*'] } }
    expect(aliasModulePaths('@/x', config)).toEqual(['/repo/app/src/x'])
    expect(aliasModulePaths('react', config)).toEqual([])
  })

  it('parses a tsconfig with comments and trailing commas', () => {
    const text = `{
      // aliases
      "extends": "./tsconfig.base.json",
      "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, /* end */ },
    }`
    expect(parseCompilerConfig(text)).toEqual({
      baseUrl: '.',
      paths: { '@/*': ['src/*'] },
      extends: ['./tsconfig.base.json']
    })
  })
})
