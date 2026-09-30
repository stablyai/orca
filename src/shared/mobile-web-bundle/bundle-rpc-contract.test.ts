import { describe, expect, it } from 'vitest'
import { sha256 } from '../sha256'
import {
  computeMobileWebBundleId,
  MOBILE_WEB_BUNDLE_ENTRYPOINT,
  MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
  type MobileWebBundleAsset
} from './manifest-contract'
import {
  MobileWebBundleChunkParamsSchema,
  MobileWebBundleChunkResultSchema,
  MobileWebBundleErrorCodeSchema,
  MobileWebBundleManifestResultSchema,
  MOBILE_WEB_BUNDLE_CHUNK_BYTES,
  MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  MOBILE_WEB_BUNDLE_ERROR_CODES,
  MOBILE_WEB_BUNDLE_MANIFEST_METHOD
} from './bundle-rpc-contract'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from './mobile-web-bundle-capability'

const BUILD_ID = 'a'.repeat(64)
const MAX_DATA_BASE64_LENGTH = Math.ceil(MOBILE_WEB_BUNDLE_CHUNK_BYTES / 3) * 4

function hexDigest(input: string): string {
  return Array.from(sha256(new TextEncoder().encode(input)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

const ENTRY_ASSET: MobileWebBundleAsset = {
  path: MOBILE_WEB_BUNDLE_ENTRYPOINT,
  sha256: hexDigest(MOBILE_WEB_BUNDLE_ENTRYPOINT),
  byteLength: 64,
  contentType: 'text/html; charset=utf-8'
}

const VALID_MANIFEST = {
  schemaVersion: MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
  buildId: computeMobileWebBundleId([ENTRY_ASSET]),
  desktopVersion: '1.4.200',
  minCompatibleRuntimeProtocolVersion: 3,
  runtimeProtocolVersion: 3,
  entrypoint: MOBILE_WEB_BUNDLE_ENTRYPOINT,
  totalBytes: ENTRY_ASSET.byteLength,
  assets: [ENTRY_ASSET],
  routes: []
}

function chunkResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    buildId: BUILD_ID,
    path: 'assets/a.js',
    offset: 0,
    assetByteLength: 1024,
    sha256: 'b'.repeat(64),
    dataBase64: 'AAAA',
    eof: true,
    ...overrides
  }
}

describe('names and sizes', () => {
  it('pins the wire constants', () => {
    expect(MOBILE_WEB_BUNDLE_CHUNK_BYTES).toBe(49152)
    expect(MOBILE_WEB_BUNDLE_MANIFEST_METHOD).toBe('mobileWeb.bundle.manifest')
    expect(MOBILE_WEB_BUNDLE_CHUNK_METHOD).toBe('mobileWeb.bundle.chunk')
    expect(MOBILE_WEB_BUNDLE_CAPABILITY).toBe('mobileWeb.bundle.v1')
  })
})

describe('MobileWebBundleErrorCodeSchema', () => {
  it('round-trips every code', () => {
    expect(MOBILE_WEB_BUNDLE_ERROR_CODES).toHaveLength(6)
    for (const code of MOBILE_WEB_BUNDLE_ERROR_CODES) {
      expect(MobileWebBundleErrorCodeSchema.parse(code)).toBe(code)
    }
  })

  it('is closed', () => {
    expect(MobileWebBundleErrorCodeSchema.safeParse('mobile_web_bundle_unknown').success).toBe(
      false
    )
    expect(MobileWebBundleErrorCodeSchema.safeParse('').success).toBe(false)
  })
})

describe('mobileWeb.bundle.manifest payloads', () => {
  it('carries a parsed manifest and the advertised chunk size', () => {
    const reply = { manifest: VALID_MANIFEST, chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES }
    const parsed = MobileWebBundleManifestResultSchema.safeParse(reply)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.manifest.buildId).toBe(VALID_MANIFEST.buildId)
    expect(MobileWebBundleManifestResultSchema.safeParse({ ...reply, manifest: {} }).success).toBe(
      false
    )
    expect(MobileWebBundleManifestResultSchema.safeParse({ ...reply, extra: 1 }).success).toBe(
      false
    )
  })

  it('allows a shrunk chunk size but not one past the constant', () => {
    const reply = { manifest: VALID_MANIFEST, chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES }
    expect(
      MobileWebBundleManifestResultSchema.safeParse({ ...reply, chunkBytes: 8 * 1024 }).success
    ).toBe(true)
    expect(
      MobileWebBundleManifestResultSchema.safeParse({
        ...reply,
        chunkBytes: MOBILE_WEB_BUNDLE_CHUNK_BYTES + 1
      }).success
    ).toBe(false)
    expect(MobileWebBundleManifestResultSchema.safeParse({ ...reply, chunkBytes: 0 }).success).toBe(
      false
    )
  })
})

describe('mobileWeb.bundle.chunk params', () => {
  const params = { buildId: BUILD_ID, path: 'assets/a.js', offset: 0 }

  it('accepts a well-formed request', () => {
    expect(MobileWebBundleChunkParamsSchema.safeParse(params).success).toBe(true)
  })

  it('is strict and bounded', () => {
    expect(MobileWebBundleChunkParamsSchema.safeParse({ ...params, gzip: true }).success).toBe(
      false
    )
    expect(MobileWebBundleChunkParamsSchema.safeParse({ ...params, offset: -1 }).success).toBe(
      false
    )
    expect(MobileWebBundleChunkParamsSchema.safeParse({ ...params, offset: 1.5 }).success).toBe(
      false
    )
    expect(
      MobileWebBundleChunkParamsSchema.safeParse({ ...params, path: '../escape.js' }).success
    ).toBe(false)
    expect(MobileWebBundleChunkParamsSchema.safeParse({ ...params, buildId: 'abc' }).success).toBe(
      false
    )
  })

  it('does not pin offset to the constant chunk size, so the host may shrink it', () => {
    expect(MobileWebBundleChunkParamsSchema.safeParse({ ...params, offset: 1024 }).success).toBe(
      true
    )
  })
})

describe('mobileWeb.bundle.chunk result', () => {
  it('accepts a self-describing chunk', () => {
    expect(MobileWebBundleChunkResultSchema.safeParse(chunkResult()).success).toBe(true)
  })

  it('accepts base64 of a full chunk and rejects one character past the bound', () => {
    const full = Buffer.alloc(MOBILE_WEB_BUNDLE_CHUNK_BYTES).toString('base64')
    expect(full.length).toBeLessThanOrEqual(MAX_DATA_BASE64_LENGTH)
    expect(
      MobileWebBundleChunkResultSchema.safeParse(chunkResult({ dataBase64: full })).success
    ).toBe(true)

    const atBound = 'A'.repeat(MAX_DATA_BASE64_LENGTH)
    expect(
      MobileWebBundleChunkResultSchema.safeParse(chunkResult({ dataBase64: atBound })).success
    ).toBe(true)
    expect(
      MobileWebBundleChunkResultSchema.safeParse(chunkResult({ dataBase64: `${atBound}A` })).success
    ).toBe(false)
  })

  it('is exact: base64 of one byte past a full chunk is refused', () => {
    expect(MAX_DATA_BASE64_LENGTH).toBe(65536)
    const overshoot = Buffer.alloc(MOBILE_WEB_BUNDLE_CHUNK_BYTES + 1).toString('base64')
    expect(
      MobileWebBundleChunkResultSchema.safeParse(chunkResult({ dataBase64: overshoot })).success
    ).toBe(false)
  })

  it('is strict and requires every echoed field', () => {
    expect(
      MobileWebBundleChunkResultSchema.safeParse(chunkResult({ contentEncoding: 'gzip' })).success
    ).toBe(false)
    for (const key of [
      'buildId',
      'path',
      'offset',
      'assetByteLength',
      'sha256',
      'dataBase64',
      'eof'
    ]) {
      const partial = chunkResult()
      delete partial[key]
      expect(MobileWebBundleChunkResultSchema.safeParse(partial).success).toBe(false)
    }
  })
})
