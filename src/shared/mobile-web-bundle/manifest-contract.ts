import { z } from 'zod'
import { sha256 } from '../sha256'

/** A reader that sees another value must reject rather than guess at the shape. */
export const MOBILE_WEB_BUNDLE_SCHEMA_VERSION = 1 as const

/** Page build number: shells require their minimum and wall older desktops. Bump when a shell stops handling an older page. */
export const MOBILE_WEB_PAGE_VERSION = 1

/** The only stable-named asset, and the only one that references the content-addressed names. */
export const MOBILE_WEB_BUNDLE_ENTRYPOINT = 'index.html'

// Permanent host-memory ceilings, independent of per-phase build budgets in the build verifier.
export const MOBILE_WEB_BUNDLE_MAX_ASSETS = 256
export const MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES = 32 * 1024 * 1024
export const MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES = 10 * 1024 * 1024
export const MOBILE_WEB_BUNDLE_MAX_ROUTES = 64
export const MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS = 16
// What a route's two lists can grant together; released shells cap each list alone, never the pair.
export const MOBILE_WEB_BUNDLE_MAX_GRANTED_ROUTE_GRANTS = 2 * MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS

export const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ASSET_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
// Canonical lowercase MIME with one charset space: spelling feeds buildId, so variants would give identical bytes multiple ids.
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:; charset=[a-z0-9-]+)?$/
const MAX_ASSET_PATH_LENGTH = 255
const MAX_CONTENT_TYPE_LENGTH = 128
const MAX_DESKTOP_VERSION_LENGTH = 64
const MAX_ROUTE_PATHNAME_LENGTH = 255
const MAX_GRANT_NAME_LENGTH = 64
/** Rooted, single-slash, no query and no fragment: a phone writes this into its own history. */
const ROUTE_PATHNAME_PATTERN = /^\/(?![/\\])[^?#\s]*$/
/** Plain capabilities or shell verbs native.<domain>.<action>; require at least two native segments to match the shell table and keep verbs grantable per route. */
const GRANT_NAME_PATTERN = /^(?:[a-zA-Z][a-zA-Z0-9]*|native(?:\.[a-z][a-z0-9]*){2,})$/

/** Share grant grammar with bridge init route-grant pairs; desktop and page must validate the same names. */
export const MobileWebBundleGrantNameSchema = z
  .string()
  .min(1)
  .max(MAX_GRANT_NAME_LENGTH)
  .regex(GRANT_NAME_PATTERN)

/** Portable bundle-root names: reject traversal and Windows-invalid/device segments. Regex already excludes absolute paths, backslashes, spaces and empty segments. */
function isPortableAssetSegment(segment: string): boolean {
  return (
    segment !== '.' &&
    segment !== '..' &&
    !segment.endsWith('.') &&
    !WINDOWS_RESERVED_SEGMENT.test(segment)
  )
}

export const MobileWebBundleAssetPathSchema = z
  .string()
  .max(MAX_ASSET_PATH_LENGTH)
  .regex(ASSET_PATH_PATTERN)
  .refine(
    (path) => path.split('/').every(isPortableAssetSegment),
    'asset path segment must be portable across macOS, Linux, and Windows'
  )

export const MobileWebBundleAssetSchema = z
  .object({
    path: MobileWebBundleAssetPathSchema,
    sha256: z.string().regex(SHA256_PATTERN),
    byteLength: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES),
    contentType: z.string().min(1).max(MAX_CONTENT_TYPE_LENGTH).regex(CONTENT_TYPE_PATTERN)
  })
  .strict()

export type MobileWebBundleAsset = z.infer<typeof MobileWebBundleAssetSchema>

/** Code-unit order, not `localeCompare`: the sort feeds a content hash, so it must not vary. */
function compareAssetPaths(left: MobileWebBundleAsset, right: MobileWebBundleAsset): number {
  if (left.path === right.path) {
    return 0
  }
  return left.path < right.path ? -1 : 1
}

/** Canonical buildId input: path-sorted assets, fixed key order, no whitespace. Sorting here makes the hash independent of caller order. */
export function serializeMobileWebBundleAssets(assets: readonly MobileWebBundleAsset[]): string {
  return JSON.stringify(
    [...assets].sort(compareAssetPaths).map((asset) => ({
      path: asset.path,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      contentType: asset.contentType
    }))
  )
}

/** Pure-JS SHA-256 lets phones recompute cached manifest ids; Metro provides no Node core shims. */
export function computeMobileWebBundleId(assets: readonly MobileWebBundleAsset[]): string {
  const digest = sha256(new TextEncoder().encode(serializeMobileWebBundleAssets(assets)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Bundle screen with an expo-router pathname pattern, including dynamic segments. Missing required grants selects the native screen.
 * Optional grants enrich a complete screen (ruling 37); only session grants combine both lists. Older desktops omit them and older shells gate required grants alone.
 * Old phone pageRouteSchema is z.looseObject (verified zod 4.4.3), so unknown keys survive. Publish strict bridge pairs via page-route-policy.ts routeViewOf,
 * never forward manifest entries: optional keys would reject the entire strict pair/session. */
export const MobileWebBundleRouteSchema = z
  .object({
    pathname: z.string().min(1).max(MAX_ROUTE_PATHNAME_LENGTH).regex(ROUTE_PATHNAME_PATTERN),
    grants: z.array(MobileWebBundleGrantNameSchema).max(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS),
    optionalGrants: z
      .array(MobileWebBundleGrantNameSchema)
      .max(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS)
      .optional(),
    /** The page can draw the wide host area, sidebar included, when `init` says it owns it. */
    canOwnHostArea: z.literal(true).optional(),
    /** This page also renders the narrow host area; legacy ownership remains wide-only. */
    canOwnHostAreaAcrossLayouts: z.literal(true).optional()
  })
  .strict()

export type MobileWebBundleRoute = z.infer<typeof MobileWebBundleRouteSchema>

function validateManifestInvariants(
  manifest: {
    buildId: string
    entrypoint: string
    totalBytes: number
    minCompatibleRuntimeProtocolVersion: number
    runtimeProtocolVersion: number
    assets: readonly MobileWebBundleAsset[]
  },
  context: z.RefinementCtx
): void {
  // Return on cheap failures before hashing; zod refines even after the asset-count ceiling fails.
  if (manifest.assets.length > MOBILE_WEB_BUNDLE_MAX_ASSETS) {
    return
  }
  let previousPath: string | null = null
  let summedBytes = 0
  const foldedPaths = new Set<string>()
  for (const asset of manifest.assets) {
    if (previousPath !== null && asset.path <= previousPath) {
      context.addIssue({
        code: 'custom',
        path: ['assets'],
        message: 'assets must be sorted by path and unique'
      })
      return
    }
    // Case-fold collisions on macOS/Windows would serve one file for two entries, invalidating a hash.
    const folded = asset.path.toLocaleLowerCase('en-US')
    if (foldedPaths.has(folded)) {
      context.addIssue({
        code: 'custom',
        path: ['assets'],
        message: 'asset paths must not collide when case is folded'
      })
      return
    }
    foldedPaths.add(folded)
    previousPath = asset.path
    summedBytes += asset.byteLength
  }
  // Verify declared totals or totalBytes:0 could hide 256 × 10 MiB assets.
  if (summedBytes !== manifest.totalBytes) {
    context.addIssue({
      code: 'custom',
      path: ['totalBytes'],
      message: 'totalBytes must equal the sum of asset byte lengths'
    })
    return
  }
  if (!manifest.assets.some((asset) => asset.path === manifest.entrypoint)) {
    context.addIssue({
      code: 'custom',
      path: ['entrypoint'],
      message: 'entrypoint must be one of the listed assets'
    })
    return
  }
  if (manifest.minCompatibleRuntimeProtocolVersion > manifest.runtimeProtocolVersion) {
    context.addIssue({
      code: 'custom',
      path: ['minCompatibleRuntimeProtocolVersion'],
      message: 'protocol window must not be inverted'
    })
    return
  }
  // Recompute stale ids so changed bytes cannot use an already trusted cache key.
  if (manifest.buildId !== computeMobileWebBundleId(manifest.assets)) {
    context.addIssue({
      code: 'custom',
      path: ['buildId'],
      message: 'buildId must be the content hash of the asset list'
    })
  }
}

/** Strict desktop writer with literal schemaVersion; loose, version-unpinned phone readers allow additive optional fields
 * (docs/reference/remote-wire-compatibility.md). Unknown keys may survive loose reads; removals or meaning changes require a schemaVersion bump. */
export const MobileWebBundleManifestSchema = z
  .object({
    schemaVersion: z.literal(MOBILE_WEB_BUNDLE_SCHEMA_VERSION),
    buildId: z.string().regex(SHA256_PATTERN),
    /** The app version that produced the bundle; the update wall's only honest age source. */
    desktopVersion: z.string().min(1).max(MAX_DESKTOP_VERSION_LENGTH),
    minCompatibleRuntimeProtocolVersion: z.number().int().nonnegative(),
    runtimeProtocolVersion: z.number().int().nonnegative(),
    /** `MOBILE_WEB_PAGE_VERSION` at build time; absent from a desktop older than the field. */
    pageVersion: z.number().int().nonnegative().optional(),
    entrypoint: z.literal(MOBILE_WEB_BUNDLE_ENTRYPOINT),
    totalBytes: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES),
    assets: z.array(MobileWebBundleAssetSchema).min(1).max(MOBILE_WEB_BUNDLE_MAX_ASSETS),
    /** Outside buildId’s asset hash; routes derive from the same source tree as the script, so identical assets imply identical routes. */
    routes: z.array(MobileWebBundleRouteSchema).max(MOBILE_WEB_BUNDLE_MAX_ROUTES)
  })
  .strict()
  .superRefine(validateManifestInvariants)

export type MobileWebBundleManifest = z.infer<typeof MobileWebBundleManifestSchema>
