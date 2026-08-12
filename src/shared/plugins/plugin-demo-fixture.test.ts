import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pluginManifestSchema } from './plugin-manifest'

describe('hello Orca plugin fixture', () => {
  it('uses an ESM entry that remains loadable outside a type-module package', async () => {
    const root = join(process.cwd(), 'examples', 'plugins', 'hello-orca')
    const manifest = pluginManifestSchema.parse(
      JSON.parse(await readFile(join(root, 'orca-plugin.json'), 'utf8'))
    )

    expect(manifest.main).toBe('main.mjs')
    const workerModule = (await import(pathToFileURL(join(root, manifest.main!)).href)) as {
      default?: unknown
    }
    expect(workerModule.default).toBeTypeOf('function')
  })
})
