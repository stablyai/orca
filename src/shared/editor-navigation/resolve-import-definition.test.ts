import { describe, expect, it } from 'vitest'
import { createImportDefinitionResolver } from './resolve-import-definition'

function project(files: Record<string, string>) {
  const reads: string[] = []
  const resolve = createImportDefinitionResolver({
    rootPath: '/repo',
    io: {
      pathsExist: async (paths) => paths.map((path) => path in files),
      readText: async (path) => {
        reads.push(path)
        return files[path] ?? null
      }
    }
  })
  return { resolve, reads }
}

const FROM = '/repo/src/features/trend/ui/TrendSection.tsx'

describe('createImportDefinitionResolver', () => {
  it('opens a relative import at the exported declaration', async () => {
    const { resolve } = project({
      '/repo/src/features/trend/ui/TrendChart.tsx': 'const a = 1\nexport function TrendChart() {}\n'
    })
    expect(await resolve({ specifier: './TrendChart', exportName: 'TrendChart' }, FROM)).toEqual({
      filePath: '/repo/src/features/trend/ui/TrendChart.tsx',
      line: 2,
      column: 17,
      content: 'const a = 1\nexport function TrendChart() {}\n'
    })
  })

  it('follows a barrel index to the file that declares the name', async () => {
    const { resolve } = project({
      '/repo/src/features/trend/api/index.ts':
        "export * from './other'\nexport { useTrend } from './use-trend'\n",
      '/repo/src/features/trend/api/other.ts': 'export const unrelated = 1\n',
      '/repo/src/features/trend/api/use-trend.ts': '\n\nexport const useTrend = () => null\n'
    })
    const found = await resolve({ specifier: '../api', exportName: 'useTrend' }, FROM)
    expect(found && [found.filePath, found.line, found.column]).toEqual([
      '/repo/src/features/trend/api/use-trend.ts',
      3,
      14
    ])
  })

  it('finds a name behind a star re-export', async () => {
    const { resolve } = project({
      '/repo/src/features/trend/calc/index.ts': "export * from './rates'\n",
      '/repo/src/features/trend/calc/rates.ts': 'export function changeRate() {}\n'
    })
    const found = await resolve({ specifier: '../calc', exportName: 'changeRate' }, FROM)
    expect(found && [found.filePath, found.line]).toEqual([
      '/repo/src/features/trend/calc/rates.ts',
      1
    ])
  })

  it('resolves a tsconfig paths alias from the nearest config', async () => {
    const { resolve } = project({
      '/repo/tsconfig.json':
        '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
      '/repo/src/shared/ui/Button.tsx': 'export default function Button() {}\n'
    })
    const found = await resolve({ specifier: '@/shared/ui/Button', exportName: 'default' }, FROM)
    expect(found && [found.filePath, found.line, found.column]).toEqual([
      '/repo/src/shared/ui/Button.tsx',
      1,
      1
    ])
  })

  it('applies a child baseUrl to paths inherited through extends', async () => {
    const { resolve } = project({
      '/repo/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["lib/*"] } } }',
      '/repo/src/tsconfig.json':
        '{ "extends": "../tsconfig", "compilerOptions": { "baseUrl": ".." } }',
      '/repo/lib/x.ts': 'export const x = 1\n'
    })
    expect((await resolve({ specifier: '@/x', exportName: 'x' }, FROM))?.filePath).toBe(
      '/repo/lib/x.ts'
    )
  })

  it('stops at the nearest config even when it declares no aliases', async () => {
    const { resolve } = project({
      '/repo/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["lib/*"] } } }',
      '/repo/src/tsconfig.json': '{}',
      '/repo/lib/x.ts': 'export const x = 1\n'
    })
    expect(await resolve({ specifier: '@/x', exportName: 'x' }, FROM)).toBeNull()
  })

  it('keeps a UNC root when resolving a relative import', async () => {
    const files: Record<string, string> = {
      '//server/share/repo/src/value.ts': 'export const value = 1\n'
    }
    const resolve = createImportDefinitionResolver({
      rootPath: '\\\\server\\share\\repo',
      io: {
        pathsExist: async (paths) => paths.map((path) => path in files),
        readText: async (path) => files[path] ?? null
      }
    })
    const found = await resolve(
      { specifier: './value', exportName: 'value' },
      '\\\\server\\share\\repo\\src\\main.ts'
    )
    expect(found?.filePath).toBe('//server/share/repo/src/value.ts')
  })

  it('opens the module top when the name is not declared there', async () => {
    const { resolve } = project({ '/repo/src/features/trend/types.ts': 'export {}\n' })
    const found = await resolve({ specifier: '../types', exportName: 'TrendRange' }, FROM)
    expect(found && [found.filePath, found.line, found.column]).toEqual([
      '/repo/src/features/trend/types.ts',
      1,
      1
    ])
  })

  it('returns null for a package import and for a target outside the project', async () => {
    const { resolve } = project({
      '/outside/secret.ts': 'export const secret = 1\n',
      '/repo/tsconfig.json': '{ "compilerOptions": { "paths": { "@out/*": ["../outside/*"] } } }'
    })
    expect(await resolve({ specifier: '@acme/ui', exportName: 'Badge' }, FROM)).toBeNull()
    expect(await resolve({ specifier: '@out/secret', exportName: 'secret' }, FROM)).toBeNull()
    expect(
      await resolve({ specifier: '../../../../../outside/secret', exportName: 'secret' }, FROM)
    ).toBeNull()
  })
})
