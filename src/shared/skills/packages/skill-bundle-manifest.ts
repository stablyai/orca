import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  SkillPackageFileSchema,
  computeSkillPackageDigest,
  validateSkillPackageName,
  validateSkillPackagePath,
  type SkillPackageFile
} from './skill-package-manifest'

export const SKILL_BUNDLE_SCHEMA_VERSION = 1 as const
export const AGENT_PLUGIN_SCHEMA_V1 =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' as const
export const ORCA_SKILL_BUNDLE_MANIFEST_PATH = 'dev.orca.skill-sharing/manifest.json'
export const AGENT_PLUGIN_MANIFEST_PATH = 'plugin.json'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/

const AgentPluginAuthorSchema = z
  .object({ name: z.string().optional(), email: z.string().optional(), url: z.string().optional() })
  .strict()

export const AgentPluginManifestV1Schema = z
  .object({
    $schema: z.literal(AGENT_PLUGIN_SCHEMA_V1),
    name: z.string().min(1).max(64).regex(PLUGIN_NAME_PATTERN),
    version: z.string().optional(),
    description: z.string().optional(),
    author: AgentPluginAuthorSchema.optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
  })
  .strict()

export type AgentPluginManifestV1 = z.infer<typeof AgentPluginManifestV1Schema>

export const SkillBundleEntrySchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    name: z.string(),
    description: z.string().max(4096),
    digest: z.string().regex(SHA256_PATTERN),
    files: z.array(SkillPackageFileSchema).min(1).max(512)
  })
  .strict()

export type SkillBundleEntry = z.infer<typeof SkillBundleEntrySchema>

export const SkillBundleManifestV1Schema = z
  .object({
    schemaVersion: z.literal(SKILL_BUNDLE_SCHEMA_VERSION),
    packageId: z.string().regex(ID_PATTERN),
    versionId: z.string().regex(ID_PATTERN),
    bundleName: z.string().min(1).max(64).regex(PLUGIN_NAME_PATTERN),
    description: z.string().max(4096),
    createdAt: z.iso.datetime({ offset: true }),
    skills: z.array(SkillBundleEntrySchema).min(1).max(512),
    bundleDigest: z.string().regex(SHA256_PATTERN)
  })
  .strict()

export type SkillBundleManifestV1 = z.infer<typeof SkillBundleManifestV1Schema>

function validateSkillFiles(files: readonly SkillPackageFile[]): void {
  let previousPath: string | null = null
  const foldedPaths = new Set<string>()
  for (const file of files) {
    validateSkillPackagePath(file.path)
    if (previousPath !== null && file.path <= previousPath) {
      throw new Error('skill-bundle-manifest-path-order')
    }
    previousPath = file.path
    const foldedPath = file.path.toLocaleLowerCase('en-US')
    if (foldedPaths.has(foldedPath)) {
      throw new Error('skill-bundle-case-collision')
    }
    foldedPaths.add(foldedPath)
  }
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new Error('skill-package-skill-markdown-required')
  }
}

export function computeSkillBundleDigest(skills: readonly SkillBundleEntry[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        skills.map((skill) => ({ id: skill.id, name: skill.name, digest: skill.digest }))
      )
    )
    .digest('hex')
}

export function parseAgentPluginManifest(value: unknown): AgentPluginManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('skill-bundle-plugin-manifest-invalid')
  }
  const candidate = value as Record<string, unknown>
  const extensions =
    candidate.extensions &&
    typeof candidate.extensions === 'object' &&
    !Array.isArray(candidate.extensions)
      ? candidate.extensions
      : undefined
  const parsed = AgentPluginManifestV1Schema.safeParse({
    $schema: candidate.$schema,
    name: candidate.name,
    version: candidate.version,
    description: candidate.description,
    author: candidate.author,
    homepage: candidate.homepage,
    repository: candidate.repository,
    license: candidate.license,
    keywords: candidate.keywords,
    extensions
  })
  if (!parsed.success) {
    throw new Error('skill-bundle-plugin-manifest-invalid')
  }
  return parsed.data
}

export function parseSkillBundleManifest(value: unknown): SkillBundleManifestV1 {
  const parsed = SkillBundleManifestV1Schema.safeParse(value)
  if (!parsed.success) {
    throw new Error('skill-bundle-manifest-invalid')
  }
  const foldedNames = new Set<string>()
  const ids = new Set<string>()
  let totalFiles = 0
  let totalBytes = 0
  let previousName: string | null = null
  for (const skill of parsed.data.skills) {
    validateSkillPackageName(skill.name)
    if (previousName !== null && skill.name <= previousName) {
      throw new Error('skill-bundle-skill-order')
    }
    previousName = skill.name
    const foldedName = skill.name.toLocaleLowerCase('en-US')
    if (foldedNames.has(foldedName) || ids.has(skill.id)) {
      throw new Error('skill-bundle-skill-collision')
    }
    foldedNames.add(foldedName)
    ids.add(skill.id)
    validateSkillFiles(skill.files)
    if (computeSkillPackageDigest(skill.files) !== skill.digest) {
      throw new Error('skill-bundle-skill-digest-mismatch')
    }
    totalFiles += skill.files.length
    totalBytes += skill.files.reduce((sum, file) => sum + file.size, 0)
    if (totalFiles > 512 || totalBytes > 32 * 1024 * 1024) {
      throw new Error('skill-bundle-content-limit')
    }
  }
  if (computeSkillBundleDigest(parsed.data.skills) !== parsed.data.bundleDigest) {
    throw new Error('skill-bundle-digest-mismatch')
  }
  return parsed.data
}
