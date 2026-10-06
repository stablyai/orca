import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, type ReleaseCheckout } from './release-checkout'
import {
  collectPackageImports,
  installMissingPackageStandIns,
  type PackageImports
} from './release-missing-packages'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function syntheticRelease(files: Record<string, string>): ReleaseCheckout {
  // Why realpath: vite reports module urls through macOS's /var -> /private/var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cross-version-missing-')))
  temporaryRoots.push(root)
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  return { ref: 'v0.0.0-synthetic', commit: 'f'.repeat(40), label: 'v0.0.0-synthetic', root }
}

const currentManifest = { dependencies: { 'declared-but-uninstalled': '^1.0.0' } }

/** Mirrors extraction: scan every release source file, then install the stand-ins. */
function installStandIns(
  checkout: ReleaseCheckout,
  files: Record<string, string>
): Promise<string[]> {
  const imports: PackageImports = new Map()
  for (const source of Object.values(files)) {
    collectPackageImports(source, imports)
  }
  return installMissingPackageStandIns(checkout.root, checkout.ref, imports, currentManifest)
}

describe('missing release package stand-ins', () => {
  it('loads release code that imports an uninstalled package and refuses only its use', async () => {
    const files = {
      'src/parse.ts': [
        "import Parser, { Tokenizer, type Token as T, Kind } from 'dropped-parser'",
        "import { tool } from '@scope/dropped-tool/sub'",
        "import { readFile } from 'node:fs/promises'",
        'export const loaded = typeof readFile === "function"',
        'export const parse = () => new Tokenizer()',
        'export const kind = () => Kind.STRING',
        'export const run = () => tool()',
        'export const parserIsDefault = typeof Parser === "function"',
        ''
      ].join('\n')
    }
    const checkout = syntheticRelease(files)

    const installed = await installStandIns(checkout, files)
    const parse = await importReleaseCheckoutModule(checkout, '/src/parse.ts')
    const call = (name: string): unknown => {
      const exported = parse[name]
      if (typeof exported !== 'function') {
        throw new Error(`synthetic release has no ${name} export`)
      }
      return exported()
    }

    expect(installed).toEqual(['@scope/dropped-tool', 'dropped-parser'])
    expect(parse.loaded).toBe(true)
    expect(parse.parserIsDefault).toBe(true)
    const refusal = /release v0\.0\.0-synthetic imports 'dropped-parser'.*does not install/
    expect(() => call('parse')).toThrow(refusal)
    expect(() => call('kind')).toThrow(refusal)
    expect(() => call('run')).toThrow(/imports '@scope\/dropped-tool\/sub'.*\(used 'tool'\)/)
  })

  it('leaves a package that resolves from the checkout to the real install', async () => {
    const files = {
      'src/lock.ts': "import { lock } from 'transitive-pkg'\nexport const locker = lock\n",
      'node_modules/transitive-pkg/package.json':
        '{ "name": "transitive-pkg", "type": "module", "exports": "./index.js" }\n',
      'node_modules/transitive-pkg/index.js': "export const lock = 'real'\n"
    }
    const checkout = syntheticRelease(files)

    const installed = await installStandIns(checkout, { 'src/lock.ts': files['src/lock.ts'] })
    const lock = await importReleaseCheckoutModule(checkout, '/src/lock.ts')

    expect(installed).toEqual([])
    expect(lock.locker).toBe('real')
  })

  it('keeps a package the current tree declares but cannot resolve a loud import failure', async () => {
    const files = {
      'src/broken.ts':
        "import { thing } from 'declared-but-uninstalled'\nexport const value = thing\n"
    }
    const checkout = syntheticRelease(files)

    expect(await installStandIns(checkout, files)).toEqual([])
    await expect(importReleaseCheckoutModule(checkout, '/src/broken.ts')).rejects.toThrow(
      /declared-but-uninstalled/
    )
  })

  it('ignores type-only imports, comment prose and scripts embedded in strings', async () => {
    const files = {
      'src/noise.ts': [
        "import type { Root } from 'types-only-pkg'",
        "// Read the cookie from 'the browser jar' before export",
        'export const script = "ObjC.import(\'AppKit\')"',
        'export type Tree = Root',
        ''
      ].join('\n')
    }
    const checkout = syntheticRelease(files)

    expect(await installStandIns(checkout, files)).toEqual([])
    expect(existsSync(join(checkout.root, 'node_modules'))).toBe(false)
  })
})
