export const MOBILE_WEB_CATALOG_MAX_RESULT_BYTES = 384 * 1024
export const MOBILE_WEB_CATALOG_MAX_RAW_BYTES = 768 * 1024
export const MOBILE_WEB_CATALOG_LEGACY_MAX_SEALED_BYTES = 1024 * 1024

export function identityCatalogResult(
  { locale, sha256 }: { locale: string; sha256: string },
  catalog: Record<string, unknown> | null
) {
  return { locale, sha256, catalog }
}

export function gzipCatalogResult(
  { locale, sha256, byteLength }: { locale: string; sha256: string; byteLength: number },
  gzip: { sha256: string; byteLength: number },
  dataBase64: string
) {
  return {
    locale,
    sha256,
    encoding: 'gzip' as const,
    byteLength,
    gzipByteLength: gzip.byteLength,
    gzipSha256: gzip.sha256,
    dataBase64
  }
}
