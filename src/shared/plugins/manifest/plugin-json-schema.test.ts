import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compilePluginJsonSchema as compile } from './plugin-json-schema.test-fixture'
import { pluginManifestJsonSchema } from './plugin-json-schema'
import { parsePluginManifest } from './plugin-manifest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')

function manifestFixtures(): { file: string; raw: unknown }[] {
  return ['examples/plugins', 'resources/plugins/launch'].flatMap((dir) =>
    readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name, 'orca-plugin.json'))
      .map((file) => ({ file, raw: JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) }))
  )
}

describe('published plugin schemas', () => {
  it('agrees with the runtime on every bundled and example v2 manifest', () => {
    const { validate } = compile(pluginManifestJsonSchema())
    const v2 = manifestFixtures().filter(({ raw }) =>
      JSON.stringify(raw).includes('"manifestVersion":2')
    )
    expect(v2.length).toBeGreaterThan(0)
    for (const { file, raw } of v2) {
      expect(validate(raw), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true)
      expect(parsePluginManifest(raw), file).toMatchObject({ ok: true })
    }
  })
})
