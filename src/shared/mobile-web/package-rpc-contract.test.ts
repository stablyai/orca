import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_PACKAGE_CHUNK_BASE64_CHARS,
  MOBILE_WEB_PACKAGE_GZIP_CHUNK_BYTES,
  MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES,
  MobileWebPackageAssetChunkSchema,
  MobileWebPackageAssetParamsSchema,
  MobileWebPackageGzipAssetChunkSchema
} from './package-rpc-contract'

const BUILD_ID = 'a'.repeat(64)

describe('mobile web package RPC contract', () => {
  it('accepts a normalized asset request and exact chunk response', () => {
    expect(
      MobileWebPackageAssetParamsSchema.safeParse({
        buildId: BUILD_ID,
        path: `assets/${'b'.repeat(64)}.js`,
        offset: 0
      }).success
    ).toBe(true)
    expect(
      MobileWebPackageAssetChunkSchema.safeParse({
        buildId: BUILD_ID,
        path: 'index.html',
        offset: 0,
        byteLength: 3,
        sha256: 'c'.repeat(64),
        dataBase64: Buffer.from('abc').toString('base64'),
        eof: true
      }).success
    ).toBe(true)
  })

  it('accepts a gzip chunk with separate source and wire lengths', () => {
    expect(
      MobileWebPackageGzipAssetChunkSchema.safeParse({
        buildId: BUILD_ID,
        path: 'index.html',
        offset: 0,
        sourceByteLength: 3,
        byteLength: 23,
        sha256: 'c'.repeat(64),
        dataBase64: Buffer.alloc(23).toString('base64'),
        eof: true,
        encoding: 'gzip'
      }).success
    ).toBe(true)
  })

  // The gzip ceiling used to be a flat +64, which zlib exceeds on incompressible input at every
  // level; a full-range PNG read then failed the response schema and aborted the download.
  it('covers what zlib really emits for a full incompressible range', () => {
    const source = randomBytes(MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES)

    for (const level of [0, 6, 9] as const) {
      const compressed = gzipSync(source, { level })
      expect(compressed.byteLength).toBeGreaterThan(MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES)
      expect(compressed.byteLength).toBeLessThanOrEqual(MOBILE_WEB_PACKAGE_GZIP_CHUNK_BYTES)
    }
  })

  it.each(['../secret', '/index.html', 'assets//app.js', 'assets\\app.js', 'a%2Fb.js'])(
    'rejects unsafe request path %s',
    (path) => {
      expect(
        MobileWebPackageAssetParamsSchema.safeParse({ buildId: BUILD_ID, path, offset: 0 }).success
      ).toBe(false)
    }
  )

  it('rejects unknown request fields, invalid base64, and mismatched decoded length', () => {
    expect(
      MobileWebPackageAssetParamsSchema.safeParse({
        buildId: BUILD_ID,
        path: 'index.html',
        offset: 0,
        filesystemPath: '/private/package/index.html'
      }).success
    ).toBe(false)
    const chunk = {
      buildId: BUILD_ID,
      path: 'index.html',
      offset: 0,
      byteLength: 3,
      sha256: 'c'.repeat(64),
      dataBase64: Buffer.from('abc').toString('base64'),
      eof: true
    }
    expect(
      MobileWebPackageAssetChunkSchema.safeParse({ ...chunk, dataBase64: '***=' }).success
    ).toBe(false)
    expect(MobileWebPackageAssetChunkSchema.safeParse({ ...chunk, byteLength: 4 }).success).toBe(
      false
    )
  })

  it.each([
    ['build ID', { buildId: `${BUILD_ID}\n` }],
    ['chunk hash', { sha256: `${'c'.repeat(64)}\n` }],
    ['base64 data', { dataBase64: `${Buffer.from('abc').toString('base64')}\n` }]
  ])('rejects trailing data in %s', (_case, mutation) => {
    expect(
      MobileWebPackageAssetChunkSchema.safeParse({ ...validChunk(), ...mutation }).success
    ).toBe(false)
  })

  it('rejects encoded data beyond the exact chunk ceiling', () => {
    const chunk = validChunk()
    chunk.byteLength = 48 * 1024
    chunk.dataBase64 = 'A'.repeat(MOBILE_WEB_PACKAGE_CHUNK_BASE64_CHARS + 4)
    const result = MobileWebPackageAssetChunkSchema.safeParse(chunk)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: 'too_big', path: ['dataBase64'] })
      )
    }
  })

  it.each([
    ['quoted offset', { offset: '0' }],
    ['Boolean offset', { offset: false }],
    ['quoted byte length', { byteLength: '3' }],
    ['Boolean byte length', { byteLength: true }],
    ['non-Boolean eof', { eof: 1 }],
    ['unknown field', { sourcePath: '/private/host' }]
  ])('rejects %s', (_case, mutation) => {
    expect(
      MobileWebPackageAssetChunkSchema.safeParse({ ...validChunk(), ...mutation }).success
    ).toBe(false)
  })

  it('requires the encoding marker and a positive source length', () => {
    const chunk = {
      buildId: BUILD_ID,
      path: 'index.html',
      offset: 0,
      sourceByteLength: 3,
      byteLength: 3,
      sha256: 'c'.repeat(64),
      dataBase64: Buffer.from('abc').toString('base64'),
      eof: true,
      encoding: 'gzip'
    }
    expect(
      MobileWebPackageGzipAssetChunkSchema.safeParse({ ...chunk, encoding: 'raw' }).success
    ).toBe(false)
    expect(
      MobileWebPackageGzipAssetChunkSchema.safeParse({ ...chunk, sourceByteLength: 0 }).success
    ).toBe(false)
  })
})

function validChunk(): Record<string, unknown> {
  return {
    buildId: BUILD_ID,
    path: 'index.html',
    offset: 0,
    byteLength: 3,
    sha256: 'c'.repeat(64),
    dataBase64: Buffer.from('abc').toString('base64'),
    eof: true
  }
}
