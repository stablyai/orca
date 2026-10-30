import { z } from 'zod'
import { hostUnionArms } from '../zod-salvage'
import {
  MobileWebBundleAssetPathSchema,
  MobileWebBundleManifestSchema,
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
  SHA256_PATTERN
} from './manifest-contract'

/** Legacy 48 KiB chunks fit the 1 MiB transport ceiling after double-base64 expansion (~16/9). */
export const MOBILE_WEB_BUNDLE_CHUNK_BYTES = 48 * 1024

/** Compatibility ceiling, separate from the advertised grid: 384 KiB × 16/9 ≈ 683 KiB plus envelope fits 1 MiB.
 * Gzip cannot enlarge the reply: hosts send identity when compression does not shrink it. */
export const MOBILE_WEB_BUNDLE_RANGE_BYTES = 384 * 1024

/** No params schema: dispatch substitutes {} for absent params, which cannot satisfy z.null(); host declares params: null. */
export const MOBILE_WEB_BUNDLE_MANIFEST_METHOD = 'mobileWeb.bundle.manifest'
export const MOBILE_WEB_BUNDLE_CHUNK_METHOD = 'mobileWeb.bundle.chunk'
/** Separate method because released hosts parse chunk params strictly and released phones may parse replies strictly; neither can add encoding. */
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
    /** Read the advertised grid; hosts may shrink it without client releases. The constant caps reply dataBase64. */
    chunkBytes: z.number().int().positive().max(MOBILE_WEB_BUNDLE_CHUNK_BYTES),
    /** Absent on hosts without range support; loose phone readers must fall back to chunks (Rule 1). */
    rangeBytes: z.number().int().positive().max(MOBILE_WEB_BUNDLE_RANGE_BYTES).optional()
  })
  .strict()

const windowParamsFields = {
  buildId: z.string().regex(SHA256_PATTERN),
  path: MobileWebBundleAssetPathSchema,
  offset: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES)
}

/** Host validates offset alignment against advertised chunkBytes, which may be smaller than the constant; no fixed multipleOf. */
export const MobileWebBundleChunkParamsSchema = z.object(windowParamsFields).strict()

/** The chunk params exactly, on the `rangeBytes` grid the manifest reply advertised. */
export const MobileWebBundleRangeParamsSchema = MobileWebBundleChunkParamsSchema

/** What every chunk or range reply restates about the window it answers. */
const windowHeaderFields = {
  ...windowParamsFields,
  /** Whole-asset size, paired with sha256 for reassembly; never the window size. */
  assetByteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
  eof: z.boolean()
}

/** Strict, so a later `contentEncoding` is only a Rule 1 optional-field addition for clients whose
 *  own reply readers are not strict. */
export const MobileWebBundleChunkResultSchema = z
  .object({ ...windowHeaderFields, dataBase64: z.string().max(MAX_DATA_BASE64_LENGTH) })
  .strict()

/** A chunk result plus the encoding of `dataBase64`, whose decoded length is
 *  `min(rangeBytes, assetByteLength - offset)`. */
export const MobileWebBundleRangeResultSchema = z
  .object({
    ...windowHeaderFields,
    encoding: z.enum(MOBILE_WEB_BUNDLE_RANGE_ENCODINGS),
    dataBase64: z.string().max(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH)
  })
  .strict()

export type MobileWebBundleManifestResult = z.infer<typeof MobileWebBundleManifestResultSchema>
export type MobileWebBundleChunkParams = z.infer<typeof MobileWebBundleChunkParamsSchema>
export type MobileWebBundleChunkResult = z.infer<typeof MobileWebBundleChunkResultSchema>
export type MobileWebBundleRangeParams = z.infer<typeof MobileWebBundleRangeParamsSchema>
export type MobileWebBundleRangeResult = z.infer<typeof MobileWebBundleRangeResultSchema>
