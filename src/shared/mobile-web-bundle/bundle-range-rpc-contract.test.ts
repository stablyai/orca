import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH,
  MobileWebBundleManifestResultSchema,
  MobileWebBundleRangeParamsSchema,
  MobileWebBundleRangeResultSchema
} from './bundle-rpc-contract'

const PARAMS = { buildId: 'a'.repeat(64), path: 'assets/a.js', offset: 0 }
const RESULT = {
  buildId: 'a'.repeat(64),
  path: 'assets/a.js',
  offset: 0,
  assetByteLength: 4096,
  sha256: 'b'.repeat(64),
  encoding: 'gzip',
  dataBase64: 'AAAA',
  eof: true
}

describe('mobileWeb.bundle.range contract', () => {
  it('round-trips params and result', () => {
    expect(MobileWebBundleRangeParamsSchema.parse(PARAMS)).toEqual(PARAMS)
    expect(MobileWebBundleRangeResultSchema.parse(RESULT)).toEqual(RESULT)
    expect(
      MobileWebBundleRangeResultSchema.parse({ ...RESULT, encoding: 'identity' }).encoding
    ).toBe('identity')
  })

  // The grid is the host's `rangeBytes`; a caller-chosen length is not part of the method.
  it('takes exactly the chunk params, with no length', () => {
    expect(MobileWebBundleRangeParamsSchema.safeParse({ ...PARAMS, length: 4096 }).success).toBe(
      false
    )
  })

  it('rejects unknown result fields, unsupported encoding, and oversized data', () => {
    expect(
      MobileWebBundleRangeResultSchema.safeParse({
        ...RESULT,
        dataBase64: 'A'.repeat(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH)
      }).success
    ).toBe(true)
    expect(MobileWebBundleRangeResultSchema.safeParse({ ...RESULT, extra: 1 }).success).toBe(false)
    expect(MobileWebBundleRangeResultSchema.safeParse({ ...RESULT, encoding: 'br' }).success).toBe(
      false
    )
    expect(
      MobileWebBundleRangeResultSchema.safeParse({
        ...RESULT,
        dataBase64: 'A'.repeat(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH + 1)
      }).success
    ).toBe(false)
  })
})

describe('the manifest reply names the range grid', () => {
  const rangeBytes = MobileWebBundleManifestResultSchema.shape.rangeBytes

  it('is optional, so a host without the range method says nothing', () => {
    expect(rangeBytes.safeParse(undefined).success).toBe(true)
  })

  it('is capped at the range constant', () => {
    expect(rangeBytes.safeParse(MOBILE_WEB_BUNDLE_RANGE_BYTES).success).toBe(true)
    expect(rangeBytes.safeParse(MOBILE_WEB_BUNDLE_RANGE_BYTES + 1).success).toBe(false)
    expect(rangeBytes.safeParse(0).success).toBe(false)
  })
})
