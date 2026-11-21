import * as z from 'zod'
import {
  MOBILE_WEB_BUNDLE_RANGE_BYTES,
  MOBILE_WEB_BUNDLE_RANGE_ENCODINGS,
  MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH
} from './bundle-rpc-contract'
import {
  MobileWebBundleCatalogLocaleSchema,
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
  SHA256_PATTERN
} from './manifest-contract'

/** The page's UI-language catalog, served from the build's host-only `catalogs` instead of shipping in every update. */
export const MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD = 'mobileWeb.bundle.localeCatalog'

/** The largest catalog `localeCatalog` sends whole: its sealed reply must fit a 1 MiB relay frame.
 *  A larger one goes only in ranges, so pages that predate them never receive it. */
export const MOBILE_WEB_BUNDLE_LOCALE_CATALOG_MAX_REPLY_BYTES = MOBILE_WEB_BUNDLE_RANGE_BYTES

/** Windows of a catalog's JSON; its own method, because released hosts parse `localeCatalog` params strictly. */
export const MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_METHOD = 'mobileWeb.bundle.localeCatalogRange'

/** The asset range ceiling, so a catalog that fits one reply still arrives in one window. */
export const MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES = MOBILE_WEB_BUNDLE_RANGE_BYTES

/** At most three windows before the first paint, and the page's stored copy stays under the device store's value cap. */
export const MOBILE_WEB_BUNDLE_LOCALE_CATALOG_MAX_BYTES = 1024 * 1024

export const MobileWebBundleLocaleCatalogParamsSchema = z
  .object({
    locale: MobileWebBundleCatalogLocaleSchema,
    /** The copy the phone already holds; a match answers with no catalog. */
    knownSha256: z.string().regex(SHA256_PATTERN).optional()
  })
  .strict()

export const MobileWebBundleLocaleCatalogResultSchema = z
  .object({
    locale: MobileWebBundleCatalogLocaleSchema,
    sha256: z.string().regex(SHA256_PATTERN),
    /** Null when `knownSha256` already names this catalog. */
    catalog: z.record(z.string(), z.unknown()).nullable()
  })
  .strict()

export const MobileWebBundleLocaleCatalogRangeParamsSchema = z
  .object({
    ...MobileWebBundleLocaleCatalogParamsSchema.shape,
    /** On the `MOBILE_WEB_BUNDLE_LOCALE_CATALOG_RANGE_BYTES` grid. */
    offset: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES)
  })
  .strict()

/** One window, restating the whole catalog's hash and length so the page checks what it reassembles. */
export const MobileWebBundleLocaleCatalogRangeResultSchema = z
  .object({
    locale: MobileWebBundleCatalogLocaleSchema,
    sha256: z.string().regex(SHA256_PATTERN),
    byteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
    offset: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
    eof: z.boolean(),
    encoding: z.enum(MOBILE_WEB_BUNDLE_RANGE_ENCODINGS),
    /** Null when `knownSha256` already names this catalog. */
    dataBase64: z.string().max(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH).nullable()
  })
  .strict()

export type MobileWebBundleLocaleCatalogParams = z.infer<
  typeof MobileWebBundleLocaleCatalogParamsSchema
>
export type MobileWebBundleLocaleCatalogResult = z.infer<
  typeof MobileWebBundleLocaleCatalogResultSchema
>
export type MobileWebBundleLocaleCatalogRangeParams = z.infer<
  typeof MobileWebBundleLocaleCatalogRangeParamsSchema
>
export type MobileWebBundleLocaleCatalogRangeResult = z.infer<
  typeof MobileWebBundleLocaleCatalogRangeResultSchema
>
