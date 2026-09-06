import { z } from 'zod'

export const MOBILE_WEB_MANIFEST_SCHEMA_VERSION = 1
export const MOBILE_WEB_PACKAGE_CHUNK_BYTES = 48 * 1024
export const MOBILE_WEB_MAX_ASSET_BYTES = 10 * 1024 * 1024
export const MOBILE_WEB_MAX_PACKAGE_BYTES = 32 * 1024 * 1024
export const MOBILE_WEB_MAX_ASSET_COUNT = 256
export const MOBILE_WEB_MAX_PATH_CHARS = 240
export const MOBILE_WEB_MAX_BRIDGE_VERSION = 65_535
export const MOBILE_WEB_ENTRYPOINT_PATH = 'index.html'
export const MOBILE_WEB_EMBEDDED_DOCUMENT_PATHS = ['mermaid-frame.html'] as const

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/
const CONTENT_ADDRESSED_PATH_PATTERN = /^assets\/([a-f0-9]{64})\.(css|js|png|svg|wasm|webp|woff2)$/

const MobileWebAssetRoleSchema = z.enum(['document', 'script', 'style', 'font', 'image', 'wasm'])

const MobileWebContentTypeSchema = z.enum([
  'text/html; charset=utf-8',
  'text/javascript; charset=utf-8',
  'text/css; charset=utf-8',
  'font/woff2',
  'image/png',
  'image/svg+xml; charset=utf-8',
  'image/webp',
  'application/wasm'
])

export const MOBILE_WEB_ASSET_METADATA_BY_EXTENSION = {
  css: { contentType: 'text/css; charset=utf-8', role: 'style' },
  js: { contentType: 'text/javascript; charset=utf-8', role: 'script' },
  png: { contentType: 'image/png', role: 'image' },
  svg: { contentType: 'image/svg+xml; charset=utf-8', role: 'image' },
  wasm: { contentType: 'application/wasm', role: 'wasm' },
  webp: { contentType: 'image/webp', role: 'image' },
  woff2: { contentType: 'font/woff2', role: 'font' }
} as const

const MobileWebAssetPathSchema = z
  .string()
  .refine(isMobileWebAssetPath, 'Asset path must be normalized and relative')

export const MobileWebAssetSchema = z
  .object({
    path: MobileWebAssetPathSchema,
    sha256: z.string().refine(isMobileWebSha256),
    byteLength: z.number().int().positive().max(MOBILE_WEB_MAX_ASSET_BYTES),
    contentType: MobileWebContentTypeSchema,
    role: MobileWebAssetRoleSchema
  })
  .strict()
  .superRefine(validateContentAddressedAsset)

const MobileWebBridgeRangeSchema = z
  .object({
    minimum: z.number().int().positive().max(MOBILE_WEB_MAX_BRIDGE_VERSION),
    testedThrough: z.number().int().positive().max(MOBILE_WEB_MAX_BRIDGE_VERSION)
  })
  .strict()
  .refine((range) => range.minimum <= range.testedThrough, {
    message: 'Bridge minimum must not exceed testedThrough',
    path: ['minimum']
  })

export const MobileWebManifestSchema = z
  .object({
    schemaVersion: z.literal(MOBILE_WEB_MANIFEST_SCHEMA_VERSION),
    buildId: z.string().refine(isMobileWebSha256),
    bridge: MobileWebBridgeRangeSchema,
    entrypoint: MobileWebAssetPathSchema,
    totalBytes: z.number().int().positive().max(MOBILE_WEB_MAX_PACKAGE_BYTES),
    assets: z.array(MobileWebAssetSchema).min(1).max(MOBILE_WEB_MAX_ASSET_COUNT)
  })
  .strict()
  .superRefine(validateManifestRelationships)

export type MobileWebAsset = z.infer<typeof MobileWebAssetSchema>
export type MobileWebManifest = z.infer<typeof MobileWebManifestSchema>
export type MobileWebBridgeRange = MobileWebManifest['bridge']

export function supportsMobileWebBridgeVersion(
  range: MobileWebBridgeRange,
  shellBridgeVersion: number
): boolean {
  return (
    Number.isInteger(shellBridgeVersion) &&
    shellBridgeVersion >= range.minimum &&
    shellBridgeVersion <= range.testedThrough
  )
}

export function isMobileWebAssetPath(path: string): boolean {
  if (
    path.length < 1 ||
    path.length > MOBILE_WEB_MAX_PATH_CHARS ||
    SAFE_PATH_PATTERN.exec(path)?.[0] !== path ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('//')
  ) {
    return false
  }
  return path.split('/').every((segment) => segment !== '.' && segment !== '..')
}

export function isMobileWebAssetMetadata(
  path: string,
  sha256: string,
  contentType: string,
  role: string
): boolean {
  if (!isMobileWebAssetPath(path) || !isMobileWebSha256(sha256)) {
    return false
  }
  if (role === 'document') {
    return (
      (path === MOBILE_WEB_ENTRYPOINT_PATH ||
        MOBILE_WEB_EMBEDDED_DOCUMENT_PATHS.includes(
          path as (typeof MOBILE_WEB_EMBEDDED_DOCUMENT_PATHS)[number]
        )) &&
      contentType === 'text/html; charset=utf-8'
    )
  }
  const match = CONTENT_ADDRESSED_PATH_PATTERN.exec(path)
  if (!match || match[0] !== path || match[1] !== sha256) {
    return false
  }
  const metadata =
    MOBILE_WEB_ASSET_METADATA_BY_EXTENSION[
      match[2] as keyof typeof MOBILE_WEB_ASSET_METADATA_BY_EXTENSION
    ]
  return metadata.contentType === contentType && metadata.role === role
}

function isMobileWebSha256(value: string): boolean {
  return SHA256_PATTERN.exec(value)?.[0] === value
}

export function serializeMobileWebManifestForBuildId(manifest: MobileWebManifest): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    bridge: {
      minimum: manifest.bridge.minimum,
      testedThrough: manifest.bridge.testedThrough
    },
    entrypoint: manifest.entrypoint,
    totalBytes: manifest.totalBytes,
    assets: manifest.assets.map((asset) => ({
      path: asset.path,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      contentType: asset.contentType,
      role: asset.role
    }))
  })
}

function validateContentAddressedAsset(asset: MobileWebAsset, context: z.RefinementCtx): void {
  if (!isMobileWebAssetMetadata(asset.path, asset.sha256, asset.contentType, asset.role)) {
    context.addIssue({
      code: 'custom',
      message: 'Asset path, hash, content type, and role must agree'
    })
  }
}

function validateManifestRelationships(
  manifest: Omit<MobileWebManifest, never>,
  context: z.RefinementCtx
): void {
  let totalBytes = 0
  let documentCount = 0
  let entrypointFound = false

  manifest.assets.forEach((asset, index) => {
    totalBytes += asset.byteLength
    documentCount += asset.role === 'document' ? 1 : 0
    entrypointFound ||= asset.path === manifest.entrypoint && asset.role === 'document'
    if (index > 0 && manifest.assets[index - 1]!.path >= asset.path) {
      context.addIssue({
        code: 'custom',
        message: 'Assets must have unique paths sorted in ascending order',
        path: ['assets', index, 'path']
      })
    }
  })

  if (
    documentCount < 1 ||
    documentCount > 1 + MOBILE_WEB_EMBEDDED_DOCUMENT_PATHS.length ||
    manifest.entrypoint !== MOBILE_WEB_ENTRYPOINT_PATH ||
    !entrypointFound
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Manifest must contain the fixed document entrypoint and only reserved documents',
      path: ['entrypoint']
    })
  }
  if (totalBytes !== manifest.totalBytes) {
    context.addIssue({
      code: 'custom',
      message: 'totalBytes must equal the sum of asset byte lengths',
      path: ['totalBytes']
    })
  }
}
