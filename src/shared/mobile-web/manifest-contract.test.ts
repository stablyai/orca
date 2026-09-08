import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
  MOBILE_WEB_MAX_ASSET_BYTES,
  MOBILE_WEB_MAX_ASSET_COUNT,
  MobileWebAssetSchema,
  MobileWebManifestSchema,
  isMobileWebAssetPath,
  isMobileWebAssetMetadata,
  serializeMobileWebManifestForBuildId,
  supportsMobileWebBridgeVersion,
  type MobileWebManifest
} from './manifest-contract'

const SCRIPT_HASH = 'a'.repeat(64)
const STYLE_HASH = 'b'.repeat(64)
const DOCUMENT_HASH = 'c'.repeat(64)

function validManifest(): MobileWebManifest {
  return {
    schemaVersion: MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
    buildId: 'd'.repeat(64),
    bridge: { minimum: 1, testedThrough: 2 },
    entrypoint: 'index.html',
    totalBytes: 60,
    assets: [
      {
        path: `assets/${SCRIPT_HASH}.js`,
        sha256: SCRIPT_HASH,
        byteLength: 20,
        contentType: 'text/javascript; charset=utf-8',
        role: 'script'
      },
      {
        path: `assets/${STYLE_HASH}.css`,
        sha256: STYLE_HASH,
        byteLength: 10,
        contentType: 'text/css; charset=utf-8',
        role: 'style'
      },
      {
        path: 'index.html',
        sha256: DOCUMENT_HASH,
        byteLength: 30,
        contentType: 'text/html; charset=utf-8',
        role: 'document'
      }
    ]
  }
}

describe('mobile web manifest contract', () => {
  it('accepts a bounded, sorted, content-addressed package', () => {
    expect(MobileWebManifestSchema.safeParse(validManifest()).success).toBe(true)
  })

  it('accepts only the reserved secondary document with the fixed entrypoint', () => {
    const manifest = validManifest()
    manifest.assets.push({
      path: 'mermaid-frame.html',
      sha256: 'e'.repeat(64),
      byteLength: 10,
      contentType: 'text/html; charset=utf-8',
      role: 'document'
    })
    manifest.totalBytes += 10
    expect(MobileWebManifestSchema.safeParse(manifest).success).toBe(true)

    manifest.entrypoint = 'mermaid-frame.html'
    expect(MobileWebManifestSchema.safeParse(manifest).success).toBe(false)
  })

  it('rejects unknown fields at every object boundary', () => {
    expect(
      MobileWebManifestSchema.safeParse({ ...validManifest(), credential: 'do-not-accept' }).success
    ).toBe(false)
    const manifest = validManifest()
    manifest.assets[0] = { ...manifest.assets[0]!, sourcePath: '/secret' } as never
    expect(MobileWebManifestSchema.safeParse(manifest).success).toBe(false)
  })

  it('rejects hashes and build IDs with trailing data', () => {
    const build = validManifest()
    build.buildId += '\n'
    expect(MobileWebManifestSchema.safeParse(build).success).toBe(false)

    const asset = validManifest()
    asset.assets[2]!.sha256 += '\n'
    expect(MobileWebManifestSchema.safeParse(asset).success).toBe(false)
  })

  it.each(['../index.html', '/index.html', 'assets//app.js', 'assets\\app.js', 'a%2Fb.js'])(
    'rejects unsafe asset path %s',
    (path) => {
      const manifest = validManifest()
      manifest.entrypoint = path
      manifest.assets[2] = { ...manifest.assets[2]!, path }
      expect(MobileWebManifestSchema.safeParse(manifest).success).toBe(false)
    }
  )

  it.each([
    '',
    '../index.html',
    './index.html',
    '/index.html',
    'index.html/',
    'assets//app.js',
    'assets\\app.js',
    'assets/app.js?query',
    'assets/app.js#fragment',
    'assets/%2e%2e/app.js',
    'assets/./app.js',
    'assets/../app.js',
    'assets/app.js\n',
    'a'.repeat(241),
    'assets/café.js'
  ])('rejects noncanonical package path %s', (path) => {
    expect(isMobileWebAssetPath(path)).toBe(false)
  })

  it.each(['index.html', `assets/${SCRIPT_HASH}.js`, 'assets/a_b-c.d.js'])(
    'accepts canonical package path %s',
    (path) => {
      expect(isMobileWebAssetPath(path)).toBe(true)
    }
  )

  it('requires the full asset hash in non-document paths', () => {
    const manifest = validManifest()
    manifest.assets[0] = { ...manifest.assets[0]!, path: `assets/${'e'.repeat(64)}.js` }
    expect(MobileWebManifestSchema.safeParse(manifest).success).toBe(false)
  })

  it('requires extension, content type, and role to agree', () => {
    const manifest = validManifest()
    manifest.assets[0] = { ...manifest.assets[0]!, contentType: 'text/css; charset=utf-8' }
    expect(MobileWebManifestSchema.safeParse(manifest).success).toBe(false)
  })

  it.each([
    ['index.html', DOCUMENT_HASH, 'text/html; charset=utf-8', 'document'],
    ['mermaid-frame.html', DOCUMENT_HASH, 'text/html; charset=utf-8', 'document'],
    [`assets/${SCRIPT_HASH}.css`, SCRIPT_HASH, 'text/css; charset=utf-8', 'style'],
    [`assets/${SCRIPT_HASH}.js`, SCRIPT_HASH, 'text/javascript; charset=utf-8', 'script'],
    [`assets/${SCRIPT_HASH}.png`, SCRIPT_HASH, 'image/png', 'image'],
    [`assets/${SCRIPT_HASH}.svg`, SCRIPT_HASH, 'image/svg+xml; charset=utf-8', 'image'],
    [`assets/${SCRIPT_HASH}.wasm`, SCRIPT_HASH, 'application/wasm', 'wasm'],
    [`assets/${SCRIPT_HASH}.webp`, SCRIPT_HASH, 'image/webp', 'image'],
    [`assets/${SCRIPT_HASH}.woff2`, SCRIPT_HASH, 'font/woff2', 'font']
  ])('accepts exact asset metadata for %s', (path, hash, contentType, role) => {
    expect(isMobileWebAssetMetadata(path, hash, contentType, role)).toBe(true)
    expect(
      MobileWebAssetSchema.safeParse({ path, sha256: hash, byteLength: 1, contentType, role })
        .success
    ).toBe(true)
  })

  it.each([
    [`assets/${SCRIPT_HASH}.js`, SCRIPT_HASH, 'text/css; charset=utf-8', 'script'],
    [`assets/${SCRIPT_HASH}.js`, SCRIPT_HASH, 'text/javascript; charset=utf-8', 'style'],
    [`assets/${SCRIPT_HASH}.png`, SCRIPT_HASH, 'image/png; charset=utf-8', 'image'],
    [`assets/${SCRIPT_HASH}.JS`, SCRIPT_HASH, 'text/javascript; charset=utf-8', 'script'],
    [`assets/${SCRIPT_HASH}.txt`, SCRIPT_HASH, 'text/plain; charset=utf-8', 'document'],
    ['other-frame.html', DOCUMENT_HASH, 'text/html; charset=utf-8', 'document'],
    [`assets/${SCRIPT_HASH}.js`, STYLE_HASH, 'text/javascript; charset=utf-8', 'script'],
    ['index.html', DOCUMENT_HASH, 'text/html; charset=UTF-8', 'document'],
    ['index.html', DOCUMENT_HASH, 'text/html; charset=utf-8', 'document ']
  ])('rejects mismatched asset metadata for %s', (path, hash, contentType, role) => {
    expect(isMobileWebAssetMetadata(path, hash, contentType, role)).toBe(false)
  })

  it('requires one document matching the entrypoint', () => {
    const missingDocument = validManifest()
    missingDocument.entrypoint = `assets/${SCRIPT_HASH}.js`
    expect(MobileWebManifestSchema.safeParse(missingDocument).success).toBe(false)

    const duplicateDocument = validManifest()
    duplicateDocument.assets.splice(2, 0, { ...duplicateDocument.assets[2]! })
    duplicateDocument.totalBytes += 30
    expect(MobileWebManifestSchema.safeParse(duplicateDocument).success).toBe(false)
  })

  it('requires unique ascending paths and an exact total', () => {
    const unsorted = validManifest()
    unsorted.assets.reverse()
    expect(MobileWebManifestSchema.safeParse(unsorted).success).toBe(false)

    const wrongTotal = validManifest()
    wrongTotal.totalBytes += 1
    expect(MobileWebManifestSchema.safeParse(wrongTotal).success).toBe(false)
  })

  it.each([
    ['schemaVersion', (manifest: Record<string, unknown>) => (manifest.schemaVersion = '1')],
    [
      'bridge.minimum',
      (manifest: Record<string, unknown>) =>
        ((manifest.bridge as Record<string, unknown>).minimum = '1')
    ],
    [
      'bridge.testedThrough',
      (manifest: Record<string, unknown>) =>
        ((manifest.bridge as Record<string, unknown>).testedThrough = '2')
    ],
    ['totalBytes', (manifest: Record<string, unknown>) => (manifest.totalBytes = '60')],
    [
      'assets.byteLength',
      (manifest: Record<string, unknown>) => {
        const assets = manifest.assets as Record<string, unknown>[]
        assets[0]!.byteLength = '20'
      }
    ]
  ])('rejects quoted numeric field %s', (_field, mutate) => {
    const manifest = validManifest() as unknown as Record<string, unknown>
    mutate(manifest)
    expect(MobileWebManifestSchema.safeParse(manifest).success).toBe(false)
  })

  it.each([
    ['schemaVersion', (manifest: Record<string, unknown>) => (manifest.schemaVersion = true)],
    [
      'bridge.minimum',
      (manifest: Record<string, unknown>) =>
        ((manifest.bridge as Record<string, unknown>).minimum = true)
    ],
    [
      'bridge.testedThrough',
      (manifest: Record<string, unknown>) =>
        ((manifest.bridge as Record<string, unknown>).testedThrough = true)
    ],
    ['totalBytes', (manifest: Record<string, unknown>) => (manifest.totalBytes = true)],
    [
      'assets.byteLength',
      (manifest: Record<string, unknown>) => {
        const assets = manifest.assets as Record<string, unknown>[]
        assets[0]!.byteLength = true
      }
    ]
  ])('rejects Boolean numeric field %s', (_field, mutate) => {
    const manifest = validManifest() as unknown as Record<string, unknown>
    mutate(manifest)
    expect(MobileWebManifestSchema.safeParse(manifest).success).toBe(false)
  })

  it('enforces bridge, per-asset, and file-count bounds', () => {
    const invalidBridge = validManifest()
    invalidBridge.bridge = { minimum: 3, testedThrough: 2 }
    expect(MobileWebManifestSchema.safeParse(invalidBridge).success).toBe(false)

    const oversizedAsset = validManifest()
    oversizedAsset.assets[0] = {
      ...oversizedAsset.assets[0]!,
      byteLength: MOBILE_WEB_MAX_ASSET_BYTES + 1
    }
    oversizedAsset.totalBytes = MOBILE_WEB_MAX_ASSET_BYTES + 41
    expect(MobileWebManifestSchema.safeParse(oversizedAsset).success).toBe(false)

    const tooManyAssets = validManifest()
    tooManyAssets.assets = Array.from(
      { length: MOBILE_WEB_MAX_ASSET_COUNT + 1 },
      () => tooManyAssets.assets[0]!
    )
    expect(MobileWebManifestSchema.safeParse(tooManyAssets).success).toBe(false)
  })

  it('accepts an asset exactly at the reviewed ceiling', () => {
    const manifest = validManifest()
    manifest.assets[0] = {
      ...manifest.assets[0]!,
      byteLength: MOBILE_WEB_MAX_ASSET_BYTES
    }
    manifest.totalBytes = MOBILE_WEB_MAX_ASSET_BYTES + 40

    expect(MobileWebManifestSchema.safeParse(manifest).success).toBe(true)
  })

  it('accepts only shell bridge versions inside the declared tested range', () => {
    const range = validManifest().bridge

    expect(supportsMobileWebBridgeVersion(range, 1)).toBe(true)
    expect(supportsMobileWebBridgeVersion(range, 2)).toBe(true)
    expect(supportsMobileWebBridgeVersion(range, 0)).toBe(false)
    expect(supportsMobileWebBridgeVersion(range, 3)).toBe(false)
    expect(supportsMobileWebBridgeVersion(range, 1.5)).toBe(false)
  })

  it('serializes canonical build identity fields without buildId', () => {
    const manifest = validManifest()
    const serialized = serializeMobileWebManifestForBuildId(manifest)

    expect(serialized).not.toContain(manifest.buildId)
    expect(JSON.parse(serialized)).toEqual({
      schemaVersion: 1,
      bridge: { minimum: 1, testedThrough: 2 },
      entrypoint: 'index.html',
      totalBytes: 60,
      assets: manifest.assets
    })
  })
})
