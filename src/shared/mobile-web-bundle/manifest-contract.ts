import { z } from 'zod'
import { sha256 } from '../sha256'

/** A reader that sees another value must reject rather than guess at the shape. */
export const MOBILE_WEB_BUNDLE_SCHEMA_VERSION = 1 as const

/** The only stable-named asset, and the only one that references the content-addressed names. */
export const MOBILE_WEB_BUNDLE_ENTRYPOINT = 'index.html'

// Permanent contract ceilings. They bound host memory at manifest-read time and never move with the
// per-phase build budget, which lives in the build's own verifier.
export const MOBILE_WEB_BUNDLE_MAX_ASSETS = 256
export const MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES = 32 * 1024 * 1024
export const MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES = 10 * 1024 * 1024

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ASSET_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const CONTENT_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:; ?charset=[a-z0-9-]+)?$/i
const MAX_ASSET_PATH_LENGTH = 255
const MAX_CONTENT_TYPE_LENGTH = 128
const MAX_DESKTOP_VERSION_LENGTH = 64

/** Relative POSIX path with no traversal, so resolving a manifest member against the bundle root
 *  cannot escape it. The regex already bans absolute paths, backslashes, and empty segments. */
export const MobileWebBundleAssetPathSchema = z
  .string()
  .max(MAX_ASSET_PATH_LENGTH)
  .regex(ASSET_PATH_PATTERN)
  .refine(
    (path) => !path.split('/').some((segment) => segment === '.' || segment === '..'),
    'asset path must not contain a relative segment'
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

/** The one input to `buildId`: assets sorted by path, fixed key order, no whitespace. Sorting here
 *  rather than requiring it of the caller is what makes the id a pure function of content. */
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

/** Pure-JS sha256 rather than `node:crypto`: Metro ships no Node core shims, so the phone must be
 *  able to recompute the id from a manifest it cached. */
export function computeMobileWebBundleId(assets: readonly MobileWebBundleAsset[]): string {
  const digest = sha256(new TextEncoder().encode(serializeMobileWebBundleAssets(assets)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

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
  let previousPath: string | null = null
  let summedBytes = 0
  for (const asset of manifest.assets) {
    if (previousPath !== null && asset.path <= previousPath) {
      context.addIssue({
        code: 'custom',
        path: ['assets'],
        message: 'assets must be sorted by path and unique'
      })
      return
    }
    previousPath = asset.path
    summedBytes += asset.byteLength
  }
  // Without this the total ceiling bounds nothing: a manifest could declare totalBytes 0 and still
  // list 256 assets of 10 MiB each.
  if (summedBytes !== manifest.totalBytes) {
    context.addIssue({
      code: 'custom',
      path: ['totalBytes'],
      message: 'totalBytes must equal the sum of asset byte lengths'
    })
  }
  if (!manifest.assets.some((asset) => asset.path === manifest.entrypoint)) {
    context.addIssue({
      code: 'custom',
      path: ['entrypoint'],
      message: 'entrypoint must be one of the listed assets'
    })
  }
  if (manifest.minCompatibleRuntimeProtocolVersion > manifest.runtimeProtocolVersion) {
    context.addIssue({
      code: 'custom',
      path: ['minCompatibleRuntimeProtocolVersion'],
      message: 'protocol window must not be inverted'
    })
  }
  // Last because it is the only check that hashes. A stale id would survive every other check and
  // then serve the wrong bytes under a cache key the client already trusts.
  if (manifest.buildId !== computeMobileWebBundleId(manifest.assets)) {
    context.addIssue({
      code: 'custom',
      path: ['buildId'],
      message: 'buildId must be the content hash of the asset list'
    })
  }
}

export const MobileWebBundleManifestSchema = z
  .object({
    schemaVersion: z.literal(MOBILE_WEB_BUNDLE_SCHEMA_VERSION),
    buildId: z.string().regex(SHA256_PATTERN),
    /** The app version that produced the bundle; the update wall's only honest age source. */
    desktopVersion: z.string().min(1).max(MAX_DESKTOP_VERSION_LENGTH),
    minCompatibleRuntimeProtocolVersion: z.number().int().nonnegative(),
    runtimeProtocolVersion: z.number().int().nonnegative(),
    entrypoint: z.literal(MOBILE_WEB_BUNDLE_ENTRYPOINT),
    totalBytes: z.number().int().nonnegative().max(MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES),
    assets: z.array(MobileWebBundleAssetSchema).min(1).max(MOBILE_WEB_BUNDLE_MAX_ASSETS)
  })
  .strict()
  .superRefine(validateManifestInvariants)

export type MobileWebBundleManifest = z.infer<typeof MobileWebBundleManifestSchema>
