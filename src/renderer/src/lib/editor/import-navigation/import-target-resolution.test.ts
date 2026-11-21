import { describe, expect, it } from 'vitest'
import type { ImportNavigationFileAccess } from './import-navigation-file-access'
import { resolveImportNavigationTarget } from './import-target-resolution'

function memoryFiles(files: Record<string, string>): ImportNavigationFileAccess {
  const exists = (path: string): boolean =>
    path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`))
  return {
    pathsExist: async (paths) => paths.map(exists),
    readText: async (path) => files[path] ?? null
  }
}

function landing(content: string, marker: string): number {
  return content.indexOf(marker)
}

const ROOT = '/repo'
const FROM = '/repo/src/features/TrendSection.tsx'

describe('resolveImportNavigationTarget', () => {
  it('opens an extensionless relative import on its exported declaration', async () => {
    const api =
      'import { http } from "./http"\n\nexport function useTrend() {\n  return http()\n}\n'
    const target = await resolveImportNavigationTarget(memoryFiles({ '/repo/src/api.ts': api }), {
      specifier: '../api',
      importedName: 'useTrend',
      fromFilePath: FROM,
      rootPath: ROOT
    })
    expect(target).toEqual({
      filePath: '/repo/src/api.ts',
      content: api,
      offset: landing(api, 'useTrend')
    })
  })

  it('maps an emitted .js specifier and a directory import to their TypeScript sources', async () => {
    const files = memoryFiles({
      '/repo/src/lib/format.ts': 'export const format = 1\n',
      '/repo/src/features/chart/index.tsx': 'export const Chart = 1\n'
    })
    const emitted = await resolveImportNavigationTarget(files, {
      specifier: '../lib/format.js',
      importedName: null,
      fromFilePath: FROM,
      rootPath: ROOT
    })
    const directory = await resolveImportNavigationTarget(files, {
      specifier: './chart',
      importedName: 'Chart',
      fromFilePath: FROM,
      rootPath: ROOT
    })
    expect(emitted?.filePath).toBe('/repo/src/lib/format.ts')
    expect(emitted?.offset).toBe(0)
    expect(directory?.filePath).toBe('/repo/src/features/chart/index.tsx')
    expect(directory?.offset).toBe(13)
  })

  it('follows a tsconfig alias kept in a referenced, extended project config', async () => {
    const button = 'type Props = {}\n\nexport default function Button(props: Props) {}\n'
    const files = memoryFiles({
      '/repo/tsconfig.json':
        '{\n  // solution root\n  "files": [],\n  "references": [{ "path": "./tsconfig.app.json" }],\n}\n',
      '/repo/tsconfig.app.json': '{ "extends": "./tsconfig.base", "include": ["src"] }',
      '/repo/tsconfig.base.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
      '/repo/src/components/Button.tsx': button
    })
    const target = await resolveImportNavigationTarget(files, {
      specifier: '@/components/Button',
      importedName: 'default',
      fromFilePath: FROM,
      rootPath: ROOT
    })
    expect(target?.filePath).toBe('/repo/src/components/Button.tsx')
    expect(target?.offset).toBe(landing(button, 'Button('))
  })

  it('follows barrel re-exports, aliases and star exports to the declaring file', async () => {
    const modal = 'export function Modal() {}\n'
    const files = memoryFiles({
      '/repo/src/ui/index.ts':
        "export * from './card'\nexport { Modal as Dialog } from './modal'\n",
      '/repo/src/ui/card.tsx': 'export const Card = () => null\n',
      '/repo/src/ui/modal.tsx': modal
    })
    const fromBarrel = (importedName: string) =>
      resolveImportNavigationTarget(files, {
        specifier: '../ui',
        importedName,
        fromFilePath: FROM,
        rootPath: ROOT
      })
    expect(await fromBarrel('Dialog')).toEqual({
      filePath: '/repo/src/ui/modal.tsx',
      content: modal,
      offset: landing(modal, 'Modal')
    })
    expect((await fromBarrel('Card'))?.filePath).toBe('/repo/src/ui/card.tsx')
  })

  it('lands on the module-level export and follows a default export of an imported binding', async () => {
    const barrel = [
      "import Card from './card'",
      'const doc = "export const title = 0"',
      'function helper() {',
      '  const title = 1',
      '  return title',
      '}',
      'const title = 2',
      'export { title }',
      'export default Card',
      ''
    ].join('\n')
    const card = 'export default function Card() {}\n'
    const files = memoryFiles({ '/repo/src/ui/index.ts': barrel, '/repo/src/ui/card.tsx': card })
    const fromBarrel = (importedName: string) =>
      resolveImportNavigationTarget(files, {
        specifier: '../ui',
        importedName,
        fromFilePath: FROM,
        rootPath: ROOT
      })
    expect((await fromBarrel('title'))?.offset).toBe(landing(barrel, 'title = 2'))
    expect(await fromBarrel('default')).toEqual({
      filePath: '/repo/src/ui/card.tsx',
      content: card,
      offset: landing(card, 'Card(')
    })
  })

  it('uses the referenced project that includes the file and its effective baseUrl', async () => {
    const files = memoryFiles({
      '/repo/tsconfig.json':
        '{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.app.json" }] }',
      '/repo/tsconfig.node.json':
        '{ "include": ["vite.config.ts"], "compilerOptions": { "paths": { "@node/*": ["./tools/*"] } } }',
      '/repo/tsconfig.app.json':
        '{ "extends": "./config/tsconfig.base.json", "include": ["src"], "compilerOptions": { "baseUrl": "." } }',
      '/repo/config/tsconfig.base.json': '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
      '/repo/src/button.ts': 'export const button = 1\n'
    })
    const target = await resolveImportNavigationTarget(files, {
      specifier: '@/button',
      importedName: null,
      fromFilePath: FROM,
      rootPath: ROOT
    })
    expect(target?.filePath).toBe('/repo/src/button.ts')
  })

  it('declines package imports and paths outside the workspace root', async () => {
    const files = memoryFiles({ '/other/shared.ts': 'export const shared = 1\n' })
    const params = { importedName: 'x', fromFilePath: FROM, rootPath: ROOT }
    expect(await resolveImportNavigationTarget(files, { ...params, specifier: 'react' })).toBeNull()
    expect(
      await resolveImportNavigationTarget(files, { ...params, specifier: '../../../other/shared' })
    ).toBeNull()
    // Why: TypeScript tries only the best alias pattern, so a missed exact alias is not retried as `@/*`.
    const aliased = memoryFiles({
      '/repo/tsconfig.json':
        '{ "compilerOptions": { "paths": { "@/special": ["../shared/special"], "@/*": ["./src/*"] } } }',
      '/repo/src/special.ts': 'export const special = 1\n'
    })
    expect(
      await resolveImportNavigationTarget(aliased, { ...params, specifier: '@/special' })
    ).toBeNull()
  })
})
