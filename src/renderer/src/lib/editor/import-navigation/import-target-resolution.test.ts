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

  it('maps .js specifiers, directory imports and `#` aliases with a query to their sources', async () => {
    const files = memoryFiles({
      '/repo/tsconfig.json': '{ "compilerOptions": { "paths": { "#/*": ["./src/*"] } } }',
      '/repo/src/lib/format.ts': 'export const format = 1\n',
      '/repo/src/features/chart/index.tsx': 'export const Chart = 1\n'
    })
    const hashAlias = await resolveImportNavigationTarget(files, {
      specifier: '#/lib/format?raw',
      importedName: null,
      fromFilePath: FROM,
      rootPath: ROOT
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
    expect(hashAlias?.filePath).toBe('/repo/src/lib/format.ts')
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
      'export namespace Legacy { export const title = 3; export const version = 1 }',
      'export const version = 2',
      'function helper() {',
      '  const title = 1',
      "  const Card = 'nested'",
      '  return [title, Card]',
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
    expect((await fromBarrel('version'))?.offset).toBe(landing(barrel, 'version = 2'))
    expect(await fromBarrel('default')).toEqual({
      filePath: '/repo/src/ui/card.tsx',
      content: card,
      offset: landing(card, 'Card(')
    })
  })

  it('uses the referenced project that owns the file, with inherited include and effective baseUrl', async () => {
    const files = memoryFiles({
      '/repo/tsconfig.json':
        '{ "files": [], "compilerOptions": { "baseUrl": "." }, "references": [{ "path": "./tsconfig.test.json" }, { "path": "./tsconfig.legacy.json" }, { "path": "./tsconfig.app.json" }] }',
      '/repo/tsconfig.test.json':
        '{ "include": ["src/**/*.test.ts"], "compilerOptions": { "paths": { "@/*": ["./test-support/*"] } } }',
      '/repo/tsconfig.legacy.json':
        '{ "include": ["src"], "exclude": ["**/features"], "compilerOptions": { "paths": { "@/*": ["./test-support/*"] } } }',
      '/repo/tsconfig.app.json':
        '{ "extends": "./config/tsconfig.base.json", "files": ["./types/env.d.ts"], "compilerOptions": { "baseUrl": "." } }',
      '/repo/config/tsconfig.base.json':
        '{ "include": ["../src"], "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
      '/repo/test-support/button.ts': 'export const button = 0\n',
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

  it('folds case in tsconfig `files` and `exclude` on Windows drives only, not POSIX or WSL', async () => {
    const resolveFrom = async (root: string, separator: string) => {
      const at = (path: string) => [root, ...path.split('/')].join(separator)
      const files = memoryFiles({
        [at('tsconfig.json')]:
          '{ "files": [], "references": [{ "path": "./tsconfig.legacy.json" }, { "path": "./tsconfig.pages.json" }, { "path": "./tsconfig.app.json" }] }',
        [at('tsconfig.legacy.json')]:
          '{ "include": ["src"], "exclude": ["**/features"], "compilerOptions": { "paths": { "@/*": ["./legacy/*"] } } }',
        [at('tsconfig.pages.json')]:
          '{ "files": ["src/features/PAGE.tsx"], "include": ["src"], "exclude": ["**/features"], "compilerOptions": { "paths": { "@/*": ["./pages/*"] } } }',
        [at('tsconfig.app.json')]:
          '{ "include": ["src"], "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
        [at('legacy/button.ts')]: 'export const button = 0\n',
        [at('pages/button.ts')]: 'export const button = 1\n',
        [at('src/button.ts')]: 'export const button = 2\n'
      })
      const target = await resolveImportNavigationTarget(files, {
        specifier: '@/button',
        importedName: null,
        fromFilePath: at('src/Features/Page.tsx'),
        rootPath: root
      })
      return target?.filePath
    }
    // Why: folded, `legacy` excludes the file and `pages` lists it; case-sensitive, `legacy` owns it.
    expect(await resolveFrom('C:\\repo', '\\')).toBe('C:\\repo\\pages\\button.ts')
    expect(await resolveFrom('/repo', '/')).toBe('/repo/legacy/button.ts')
    expect(await resolveFrom('\\\\wsl.localhost\\Ubuntu\\repo', '\\')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\repo\\legacy\\button.ts'
    )
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
