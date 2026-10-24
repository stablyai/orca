import { describe, expect, it } from 'vitest'
import {
  catalogEntryFixture,
  catalogFixture,
  v2ManifestFixture
} from './plugin-json-schema.test-fixture'
import { validatePluginFile } from './plugin-file-validation'

const VALID_RELEASE = {
  version: '1.0.0',
  commit: 'a'.repeat(40),
  contentHash: 'b'.repeat(64),
  execution: 'data',
  minimumOrca: '1.4.0',
  types: ['syntax']
}

describe('validatePluginFile', () => {
  it('passes valid files and reports manifest errors', () => {
    expect(validatePluginFile('orca-plugin.json', v2ManifestFixture())).toEqual([])
    expect(
      validatePluginFile('orca-catalog.json', catalogFixture([catalogEntryFixture()]))
    ).toEqual([])
    expect(
      validatePluginFile('orca-plugin.json', v2ManifestFixture({ engines: { orca: '>=1.0.0' } }))
    ).toEqual([expect.stringContaining('engines.orca: must be at least')])
  })

  it('turns every runtime repair of a catalog into an error', () => {
    const errors = validatePluginFile(
      'orca-catalog.json',
      catalogFixture([
        catalogEntryFixture({ categories: ['syntax', 'syntax'], description: 5 }),
        catalogEntryFixture(),
        catalogEntryFixture({
          id: 'acme.other',
          releases: [{ version: 'x' }, VALID_RELEASE]
        }),
        catalogEntryFixture({ id: 'acme.broken', releases: [] })
      ])
    )
    expect(errors).toEqual([
      'plugins[0].categories: has invalid, repeated or extra categories',
      'plugins[0].description: must be text of 1 to 4096 characters',
      'plugins[1].id: duplicate plugin id acme.gleam-syntax',
      'plugins[2].releases: 1 release(s) are unreadable or over the limit',
      'plugins[3]: releases: needs at least one release this Orca can read'
    ])
  })

  it('refuses a newer catalog format', () => {
    expect(
      validatePluginFile('orca-catalog.json', { ...catalogFixture([]), catalogVersion: 3 })
    ).toEqual(['uses catalog format 3; update Orca to browse this catalog'])
  })

  it('checks catalog images against the files in the catalog repository', () => {
    const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
    const png = (w: number, h: number) =>
      Uint8Array.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0,
        0,
        0,
        13,
        73,
        72,
        68,
        82,
        ...be32(w),
        ...be32(h),
        8,
        6,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ])
    const files: Record<string, { bytes: Uint8Array; sha256: string }> = {
      'assets/cover.png': { bytes: png(1600, 1000), sha256: 'c'.repeat(64) },
      'assets/icon.png': { bytes: png(512, 512), sha256: 'd'.repeat(64) }
    }
    const image = (path: string, sha256: string, width: number, height: number) => ({
      path,
      alt: 'An image',
      sha256,
      width,
      height
    })
    const catalog = catalogFixture([
      catalogEntryFixture(
        {},
        {
          images: {
            icon: image('assets/icon.png', 'd'.repeat(64), 256, 256),
            cover: image('assets/cover.png', 'e'.repeat(64), 1600, 1000),
            screenshots: [image('assets/missing.png', 'f'.repeat(64), 1600, 1000)]
          }
        }
      )
    ])
    expect(validatePluginFile('orca-catalog.json', catalog, (path) => files[path] ?? null)).toEqual(
      [
        'plugins[0].releases[0].images.icon: is 512×512, not 256×256',
        'plugins[0].releases[0].images.cover: sha256 does not match assets/cover.png',
        'plugins[0].releases[0].images.screenshots[0]: assets/missing.png is missing from the catalog repository'
      ]
    )
  })
})
