import { createHash } from 'node:crypto'
import { z } from 'zod'

export const SKILL_PACKAGE_SCHEMA_VERSION = 1 as const
export const SKILL_PACKAGE_CONTENT_TYPE = 'application/vnd.orca.skill+tar+gzip'
export const SKILL_PACKAGE_MAX_COMPRESSED_BYTES = 40 * 1024 * 1024
export const SKILL_PACKAGE_MAX_MANIFEST_BYTES = 1024 * 1024

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export const SkillPackageFileSchema = z
  .object({
    path: z.string().min(1).max(1024),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024),
    executable: z.boolean(),
    classification: z.enum(['text', 'binary']),
    sha256: z.string().regex(SHA256_PATTERN),
    identitySha256: z.string().regex(SHA256_PATTERN)
  })
  .strict()

export type SkillPackageFile = z.infer<typeof SkillPackageFileSchema>

export const SkillPackageManifestV1Schema = z
  .object({
    schemaVersion: z.literal(SKILL_PACKAGE_SCHEMA_VERSION),
    packageId: z.string().regex(ID_PATTERN),
    versionId: z.string().regex(ID_PATTERN),
    name: z.string().regex(SKILL_NAME_PATTERN),
    description: z.string().max(4096),
    createdAt: z.iso.datetime({ offset: true }),
    files: z.array(SkillPackageFileSchema).min(1).max(512),
    packageDigest: z.string().regex(SHA256_PATTERN)
  })
  .strict()

export type SkillPackageManifestV1 = z.infer<typeof SkillPackageManifestV1Schema>

export function validateSkillPackageName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name) || WINDOWS_RESERVED_SEGMENT.test(name)) {
    throw new Error('skill-package-skill-name-invalid')
  }
}

export function validateSkillPackagePath(path: string): void {
  if (path !== path.normalize('NFC') || Buffer.byteLength(path, 'utf8') > 1024) {
    throw new Error('skill-package-path-invalid')
  }
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new Error('skill-package-path-invalid')
  }
  const segments = path.split('/')
  if (
    segments.length > 16 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('skill-package-path-invalid')
  }
  for (const segment of segments) {
    if (
      Buffer.byteLength(segment, 'utf8') > 255 ||
      [...segment].some((character) => character.charCodeAt(0) <= 0x1f) ||
      ':*?"<>|'.split('').some((character) => segment.includes(character)) ||
      /[ .]$/.test(segment) ||
      WINDOWS_RESERVED_SEGMENT.test(segment)
    ) {
      throw new Error('skill-package-path-invalid')
    }
  }
}

export function computeSkillPackageDigest(files: readonly SkillPackageFile[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        files.map((file) => ({
          path: file.path,
          executable: file.executable,
          classification: file.classification,
          identitySha256: file.identitySha256
        }))
      )
    )
    .digest('hex')
}

export function parseSkillPackageManifest(value: unknown): SkillPackageManifestV1 {
  const parsed = SkillPackageManifestV1Schema.safeParse(value)
  if (!parsed.success) {
    throw new Error('skill-package-manifest-invalid')
  }
  validateSkillPackageName(parsed.data.name)
  let previousPath: string | null = null
  const foldedPaths = new Set<string>()
  let totalBytes = 0
  for (const file of parsed.data.files) {
    validateSkillPackagePath(file.path)
    if (previousPath !== null && file.path <= previousPath) {
      throw new Error('skill-package-manifest-path-order')
    }
    previousPath = file.path
    const folded = file.path.toLocaleLowerCase('en-US')
    if (foldedPaths.has(folded)) {
      throw new Error('skill-package-case-collision')
    }
    foldedPaths.add(folded)
    totalBytes += file.size
    if (totalBytes > 32 * 1024 * 1024) {
      throw new Error('skill-package-total-size-limit')
    }
  }
  if (!parsed.data.files.some((file) => file.path === 'SKILL.md')) {
    throw new Error('skill-package-skill-markdown-required')
  }
  if (computeSkillPackageDigest(parsed.data.files) !== parsed.data.packageDigest) {
    throw new Error('skill-package-digest-mismatch')
  }
  return parsed.data
}
