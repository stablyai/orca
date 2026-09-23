import { z } from 'zod'
import { hostUnionArms } from '../zod-salvage'
import {
  MobileWebBundleAssetPathSchema,
  MobileWebBundleManifestSchema,
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
  SHA256_PATTERN
} from './manifest-contract'

/** 48 KiB survives the compounded ~1.78x expansion (base64 body inside a base64 mobile E2EE reply)
 *  against the 1 MiB frame ceiling on both the WebSocket and relay transports. */
export const MOBILE_WEB_BUNDLE_CHUNK_BYTES = 48 * 1024

/** 384 KiB raw is 512 KiB of base64, which the base64 mobile E2EE reply grows to ~683 KiB
 *  (393216 x 16/9 = 699051 bytes) plus the envelope: under the 1 MiB WebSocket and relay frame
 *  ceiling. Gzip never raises that bound, because the host sends identity when gzip does not shrink. */
export const MOBILE_WEB_BUNDLE_RANGE_BYTES = 384 * 1024

/** Takes no params, and carries no params schema: the dispatcher substitutes `{}` for absent params,
 *  so a `z.null()` schema could never be satisfied. The method declares `params: null` host-side. */
export const MOBILE_WEB_BUNDLE_MANIFEST_METHOD = 'mobileWeb.bundle.manifest'
export const MOBILE_WEB_BUNDLE_CHUNK_METHOD = 'mobileWeb.bundle.chunk'
/** A method rather than a field on `mobileWeb.bundle.chunk`: released hosts parse chunk params
 *  strictly and released phones may read chunk replies strictly, so neither can carry an encoding. */
export const MOBILE_WEB_BUNDLE_RANGE_METHOD = 'mobileWeb.bundle.range'

export const MOBILE_WEB_BUNDLE_RANGE_ENCODINGS = ['gzip', 'identity'] as const
export type MobileWebBundleRangeEncoding = (typeof MOBILE_WEB_BUNDLE_RANGE_ENCODINGS)[number]

/** Exact base64 lengths of a full window: these bound only what this host produces. */
const MAX_DATA_BASE64_LENGTH = Math.ceil(MOBILE_WEB_BUNDLE_CHUNK_BYTES / 3) * 4
export const MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH =
  Math.ceil(MOBILE_WEB_BUNDLE_RANGE_BYTES / 3) * 4

export type MobileWebBundleErrorCode =
  | 'mobile_web_bundle_unavailable'
  | 'mobile_web_bundle_build_changed'
  | 'mobile_web_bundle_asset_unknown'
  | 'mobile_web_bundle_asset_changed'
  | 'mobile_web_bundle_offset_invalid'
  | 'mobile_web_bundle_read_limited'

/** Coverage record, so tsc fails on an arm added to the union without a schema arm and vice versa. */
export const MOBILE_WEB_BUNDLE_ERROR_CODES = hostUnionArms<MobileWebBundleErrorCode>({
  mobile_web_bundle_unavailable: true,
  mobile_web_bundle_build_changed: true,
  mobile_web_bundle_asset_unknown: true,
  mobile_web_bundle_asset_changed: true,
  mobile_web_bundle_offset_invalid: true,
  mobile_web_bundle_read_limited: true
})

export const MobileWebBundleErrorCodeSchema = z.enum(MOBILE_WEB_BUNDLE_ERROR_CODES)

export const MobileWebBundleManifestResultSchema = z
  .object({
    manifest: MobileWebBundleManifestSchema,
    /** Read, never assumed, so the host can shrink it without a client release. Capped at the
     *  constant because a larger value would overshoot the chunk reply's `dataBase64` bound. */
    chunkBytes: z.number().int().positive().max(MOBILE_WEB_BUNDLE_CHUNK_BYTES),
    /** The range grid, present only from a host that serves `mobileWeb.bundle.range`: absence is
     *  how a phone knows to stay on chunks. Optional, so a phone reading loosely sees Rule 1. */
    rangeBytes: z.number().int().positive().max(MOBILE_WEB_BUNDLE_RANGE_BYTES).optional()
  })
  .strict()

const windowParamsShape = {
  buildId: z.string().regex(SHA256_PATTERN),
  path: MobileWebBundleAssetPathSchema,
  offset: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES)
}

/** No `multipleOf` pin on `offset`: alignment is against the host's advertised `chunkBytes`, which
 *  may be smaller than the constant, so the host rejects a misaligned offset instead. */
export const MobileWebBundleChunkParamsSchema = z.object(windowParamsShape).strict()

/** The chunk params exactly, on the `rangeBytes` grid the manifest reply advertised. */
export const MobileWebBundleRangeParamsSchema = MobileWebBundleChunkParamsSchema

/** What every chunk or range reply restates about the window it answers. */
const windowHeaderShape = {
  ...windowParamsShape,
  /** The whole asset, not this window: named for it so a reassembler cannot misread the two, and
   *  paired with `sha256` it describes the asset without a second index. */
  assetByteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
  eof: z.boolean()
}

/** Strict, so a later `contentEncoding` is only a Rule 1 optional-field addition for clients whose
 *  own reply readers are not strict. */
export const MobileWebBundleChunkResultSchema = z
  .object({ ...windowHeaderShape, dataBase64: z.string().max(MAX_DATA_BASE64_LENGTH) })
  .strict()

/** A chunk result plus the encoding of `dataBase64`, whose decoded length is
 *  `min(rangeBytes, assetByteLength - offset)`. */
export const MobileWebBundleRangeResultSchema = z
  .object({
    ...windowHeaderShape,
    encoding: z.enum(MOBILE_WEB_BUNDLE_RANGE_ENCODINGS),
    dataBase64: z.string().max(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH)
  })
  .strict()

export type MobileWebBundleManifestResult = z.infer<typeof MobileWebBundleManifestResultSchema>
export type MobileWebBundleChunkParams = z.infer<typeof MobileWebBundleChunkParamsSchema>
export type MobileWebBundleChunkResult = z.infer<typeof MobileWebBundleChunkResultSchema>
export type MobileWebBundleRangeParams = z.infer<typeof MobileWebBundleRangeParamsSchema>
export type MobileWebBundleRangeResult = z.infer<typeof MobileWebBundleRangeResultSchema>
