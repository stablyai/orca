import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH,
  MOBILE_WEB_BUNDLE_RANGE_METHOD,
  MobileWebBundleManifestResultSchema,
  MobileWebBundleRangeParamsSchema,
  MobileWebBundleRangeResultSchema
} from './bundle-rpc-contract'

/** Both transports refuse a frame over 1 MiB. */
const FRAME_CEILING_BYTES = 1024 * 1024
/** base64 body inside the base64 mobile E2EE reply. */
const E2EE_EXPANSION = 16 / 9
/** Envelope, ids and every other result member, generously. */
const REPLY_OVERHEAD_BYTES = 4096

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
  it('pins the wire name and the range size', () => {
    expect(MOBILE_WEB_BUNDLE_RANGE_METHOD).toBe('mobileWeb.bundle.range')
    expect(MOBILE_WEB_BUNDLE_RANGE_BYTES).toBe(393216)
  })

  it('bounds a full identity range exactly, and it fits the frame after E2EE expansion', () => {
    expect(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH).toBe(524288)
    const wire =
      (MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH + REPLY_OVERHEAD_BYTES) *
      (E2EE_EXPANSION / (4 / 3))
    expect(wire).toBeLessThan(FRAME_CEILING_BYTES)
  })

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

  it('is strict on both sides and closed on the encoding', () => {
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
