import { z } from 'zod'
import {
  MOBILE_WEB_PACKAGE_CHUNK_BYTES,
  MobileWebManifestSchema,
  isMobileWebAssetPath
} from './manifest-contract'
import { isMobileWebBase64, isMobileWebSha256 } from './protocol-token-contract'

export const MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS = 4
// A ranged gzip read answers this many 48 KiB chunks in one round trip. 384 KiB of
// incompressible bytes still fits the relay's 1 MiB control-lane frame after gzip,
// base64, and the E2EE layer's own base64 (a ~1.78x expansion in total).
export const MOBILE_WEB_PACKAGE_RANGE_CHUNKS = 8
export const MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES =
  MOBILE_WEB_PACKAGE_RANGE_CHUNKS * MOBILE_WEB_PACKAGE_CHUNK_BYTES
export const MOBILE_WEB_PACKAGE_MAX_IN_FLIGHT_BYTES =
  MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS * MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
export const MOBILE_WEB_PACKAGE_CHUNK_BASE64_CHARS =
  Math.ceil(MOBILE_WEB_PACKAGE_CHUNK_BYTES / 3) * 4
// zlib's own deflateBound: incompressible input grows by up to a bit per byte plus a block
// header per 64 bytes, and the gzip wrapper adds a 10-byte header and an 8-byte trailer. A flat
// margin is not enough — level 6 on 384 KiB of random bytes really does exceed the source length.
export const MOBILE_WEB_PACKAGE_GZIP_WRAPPER_BYTES = 18
export function mobileWebPackageGzipBound(sourceByteLength: number): number {
  return (
    sourceByteLength +
    ((sourceByteLength + 7) >> 3) +
    ((sourceByteLength + 63) >> 6) +
    5 +
    MOBILE_WEB_PACKAGE_GZIP_WRAPPER_BYTES
  )
}
// Host->client, and the client here is the APK's downloader (mobile-web-package-chunk-decoder),
// never the hosted page — the APK ships from the store while this ceiling ships with the desktop,
// so narrowing it strands every APK already compiled against the wider one. The surface is
// unreleased, which is the only reason the retired flat +64 (9 bytes short of a stored-block
// 384 KiB range) stranded nobody.
export const MOBILE_WEB_PACKAGE_GZIP_CHUNK_BYTES = mobileWebPackageGzipBound(
  MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES
)
export const MOBILE_WEB_PACKAGE_GZIP_CHUNK_BASE64_CHARS =
  Math.ceil(MOBILE_WEB_PACKAGE_GZIP_CHUNK_BYTES / 3) * 4

export const MOBILE_WEB_PACKAGE_ERROR_CODES = [
  'mobile_web_package_unavailable',
  'mobile_web_package_build_changed',
  'mobile_web_package_build_invalid',
  'mobile_web_package_asset_unknown',
  'mobile_web_package_asset_invalid',
  'mobile_web_package_asset_changed',
  'mobile_web_package_asset_truncated',
  'mobile_web_package_asset_path_invalid',
  'mobile_web_package_offset_invalid',
  'mobile_web_package_read_limited',
  'mobile_web_package_cancelled'
] as const

const AssetPathSchema = z
  .string()
  .refine(isMobileWebAssetPath, 'Asset path must be normalized and relative')

export const MobileWebPackageManifestResponseSchema = z
  .object({
    manifest: MobileWebManifestSchema,
    chunkBytes: z.literal(MOBILE_WEB_PACKAGE_CHUNK_BYTES)
  })
  .strict()

export const MobileWebPackageAssetParamsSchema = z
  .object({
    buildId: z.string().refine(isMobileWebSha256),
    path: AssetPathSchema,
    offset: z.number().int().nonnegative(),
    // Optional, and only on mobileWeb.package.asset.gzip: hosts predating
    // MOBILE_WEB_PACKAGE_RANGE_RUNTIME_CAPABILITY reject it (the schema is strict), so
    // clients must not send it before the capability probe reports the host supports it.
    length: z
      .number()
      .int()
      .positive()
      .max(MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES)
      .refine((length) => length % MOBILE_WEB_PACKAGE_CHUNK_BYTES === 0)
      .optional()
  })
  .strict()

export const MobileWebPackageAssetChunkSchema = z
  .object({
    buildId: z.string().refine(isMobileWebSha256),
    path: AssetPathSchema,
    offset: z.number().int().nonnegative(),
    byteLength: z.number().int().positive().max(MOBILE_WEB_PACKAGE_CHUNK_BYTES),
    sha256: z.string().refine(isMobileWebSha256),
    dataBase64: z
      .string()
      .min(4)
      .max(MOBILE_WEB_PACKAGE_CHUNK_BASE64_CHARS)
      .refine(isMobileWebBase64),
    eof: z.boolean()
  })
  .strict()
  .superRefine((chunk, context) => {
    if (decodedBase64Length(chunk.dataBase64) !== chunk.byteLength) {
      context.addIssue({ code: 'custom', message: 'Chunk byte length must match base64 data' })
    }
  })

export const MobileWebPackageGzipAssetChunkSchema = z
  .object({
    buildId: z.string().refine(isMobileWebSha256),
    path: AssetPathSchema,
    offset: z.number().int().nonnegative(),
    sourceByteLength: z.number().int().positive().max(MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES),
    byteLength: z.number().int().positive().max(MOBILE_WEB_PACKAGE_GZIP_CHUNK_BYTES),
    sha256: z.string().refine(isMobileWebSha256),
    dataBase64: z
      .string()
      .min(4)
      .max(MOBILE_WEB_PACKAGE_GZIP_CHUNK_BASE64_CHARS)
      .refine(isMobileWebBase64),
    eof: z.boolean(),
    encoding: z.literal('gzip')
  })
  .strict()
  .superRefine((chunk, context) => {
    if (decodedBase64Length(chunk.dataBase64) !== chunk.byteLength) {
      context.addIssue({ code: 'custom', message: 'Chunk byte length must match gzip data' })
    }
  })

export type MobileWebPackageManifestResponse = z.infer<
  typeof MobileWebPackageManifestResponseSchema
>
export type MobileWebPackageAssetParams = z.infer<typeof MobileWebPackageAssetParamsSchema>
export type MobileWebPackageAssetChunk = z.infer<typeof MobileWebPackageAssetChunkSchema>
export type MobileWebPackageGzipAssetChunk = z.infer<typeof MobileWebPackageGzipAssetChunkSchema>
export type MobileWebPackageErrorCode = (typeof MOBILE_WEB_PACKAGE_ERROR_CODES)[number]

const MOBILE_WEB_PACKAGE_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  MOBILE_WEB_PACKAGE_ERROR_CODES
)

export function isMobileWebPackageErrorCode(value: string): value is MobileWebPackageErrorCode {
  return MOBILE_WEB_PACKAGE_ERROR_CODE_SET.has(value)
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}
