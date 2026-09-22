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
export const MOBILE_WEB_BUNDLE_MAX_ROUTES = 64
export const MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS = 16

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ASSET_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
// One spelling only, lowercase with a single space before `charset`: content type feeds the build
// id, so every accepted variant of the same type is another id for the same bytes.
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:; charset=[a-z0-9-]+)?$/
const MAX_ASSET_PATH_LENGTH = 255
const MAX_CONTENT_TYPE_LENGTH = 128
const MAX_DESKTOP_VERSION_LENGTH = 64
const MAX_ROUTE_PATHNAME_LENGTH = 255
const MAX_GRANT_NAME_LENGTH = 64
/** Rooted, single-slash, no query and no fragment: a phone writes this into its own history. */
const ROUTE_PATHNAME_PATTERN = /^\/(?![/\\])[^?#\s]*$/
/**
 * A grant is either a plain capability name (`navigate`, `storage`, `externalLink`) or one of the
 * shell-answered verbs, which live under `native.` and are named `native.<domain>.<action>`.
 *
 * Two segments at least, so a plain name wearing a dot is still refused: the verb namespace is what
 * the shell's table declares, and a route that could not name one would never be granted one —
 * which, with grants scoped per route, leaves every verb unreachable.
 */
const GRANT_NAME_PATTERN = /^(?:[a-zA-Z][a-zA-Z0-9]*|native(?:\.[a-z][a-z0-9]*){2,})$/

/**
 * One grant name, as both the manifest and the bridge read it.
 *
 * Exported so the `init` frame's route-grant pairs are checked by the same grammar the desktop
 * wrote the manifest under. Two spellings of one rule drift, and the half that matters is the half
 * the page believes.
 */
export const MobileWebBundleGrantNameSchema = z
  .string()
  .min(1)
  .max(MAX_GRANT_NAME_LENGTH)
  .regex(GRANT_NAME_PATTERN)

/** Every segment must be a name the bundle root can hold on all three desktop platforms: no
 *  traversal, and none of the Windows shapes that cannot be created or that resolve to a device.
 *  The regex already bans absolute paths, backslashes, spaces, and empty segments. */
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

/**
 * A screen the desktop asks the phone's shell to render from this bundle rather than natively.
 *
 * `pathname` is an expo-router pattern, dynamic segments and all (`/h/[hostId]`), because the shell
 * matches a concrete route against it. `grants` names what that screen needs the shell to do on its
 * behalf; a shell that does not implement one of them renders the native screen instead, which is
 * the capability negotiation that keeps an old app against a new bundle on a working screen rather
 * than a dead tap.
 *
 * `optionalGrants` names what the screen is better with and complete without (ruling 37). Serving
 * the route reads `grants` alone, so the all-or-nothing rule above is untouched and an author who
 * cannot show a screen at all without a capability still keeps it native; only the session's
 * granted list reads both. Which side a capability goes on is the desktop's call, because the
 * desktop is what knows which screens it has proved.
 *
 * Optional rather than defaulted to `[]`: a desktop older than the field writes no key, and a shell
 * whose policy predates the field never reads one, so it serves the route on its required set.
 *
 * What it does NOT get is a reader that strips the key. `pageRouteSchema` on the phone is
 * `z.looseObject`, which passes unknown keys through rather than dropping them (measured on zod
 * 4.4.3), so the entry an older shell holds still carries this field. That is why the publish path
 * must build the pairs it hands the bridge instead of forwarding a manifest entry: the pair schema
 * is `.strict()`, and an entry reaching it refuses the whole session rather than one field. See
 * `page-route-policy.ts`'s `routeViewOf`.
 */
export const MobileWebBundleRouteSchema = z
  .object({
    pathname: z.string().min(1).max(MAX_ROUTE_PATHNAME_LENGTH).regex(ROUTE_PATHNAME_PATTERN),
    grants: z.array(MobileWebBundleGrantNameSchema).max(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS),
    optionalGrants: z
      .array(MobileWebBundleGrantNameSchema)
      .max(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS)
      .optional()
  })
  .strict()
  // The ceiling is over the union, because the union is what a session's granted list is built
  // from: two lists each under the cap would hand a page twice what the cap bounds. The per-array
  // ceilings above stay, so the arrays are bounded before this runs.
  .superRefine((route, context) => {
    if (
      route.grants.length + (route.optionalGrants?.length ?? 0) >
      MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['optionalGrants'],
        message: 'grants and optionalGrants together must not exceed the route grant ceiling'
      })
    }
  })

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
  // Cheapest first, and each check returns: the build id below is the only one that hashes, and
  // zod runs this refinement even when the array ceiling has already failed.
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
    // Two paths differing only in case are one file on macOS and Windows, so the host would serve
    // the same bytes under two entries and one of the two hashes would never match.
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
  // Without this the total ceiling bounds nothing: a manifest could declare totalBytes 0 and still
  // list 256 assets of 10 MiB each.
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
  // A stale id survives every other check and would then serve the wrong bytes under a cache key
  // the client already trusts.
  if (manifest.buildId !== computeMobileWebBundleId(manifest.assets)) {
    context.addIssue({
      code: 'custom',
      path: ['buildId'],
      message: 'buildId must be the content hash of the asset list'
    })
  }
}

/** Closed on the side that writes it: `.strict()` rejects an unknown key and `schemaVersion` is a
 *  literal, so a desktop cannot ship a manifest it did not declare here and cannot read one from a
 *  future it does not know. The phone reads the same document loosely and pins no version
 *  (`mobile-web-bundle-reply-schemas.ts`), which is what makes a field added here the additive
 *  change `docs/reference/remote-wire-compatibility.md` allows: an older phone drops what it has no
 *  use for, and a newer phone reading an older bundle sees the field absent. A change that removes
 *  a field, or changes what one already means, is still a `schemaVersion` bump. */
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
    assets: z.array(MobileWebBundleAssetSchema).min(1).max(MOBILE_WEB_BUNDLE_MAX_ASSETS),
    /** Outside `buildId`, which hashes the assets alone. The routes are derived from the same
     *  source tree the script asset is built from, so identical assets are identical routes. */
    routes: z.array(MobileWebBundleRouteSchema).max(MOBILE_WEB_BUNDLE_MAX_ROUTES)
  })
  .strict()
  .superRefine(validateManifestInvariants)

export type MobileWebBundleManifest = z.infer<typeof MobileWebBundleManifestSchema>
