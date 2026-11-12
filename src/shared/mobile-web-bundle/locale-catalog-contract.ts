import * as z from 'zod'
import { MobileWebBundleCatalogLocaleSchema, SHA256_PATTERN } from './manifest-contract'

/** The page's UI-language catalog, served from the build's host-only `catalogs` instead of shipping in every update. */
export const MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD = 'mobileWeb.bundle.localeCatalog'

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

export type MobileWebBundleLocaleCatalogParams = z.infer<
  typeof MobileWebBundleLocaleCatalogParamsSchema
>
export type MobileWebBundleLocaleCatalogResult = z.infer<
  typeof MobileWebBundleLocaleCatalogResultSchema
>
