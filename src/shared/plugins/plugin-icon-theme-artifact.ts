import { z } from 'zod'
import { pluginRelativePathSchema } from './plugin-manifest-fields'

export const PLUGIN_ICON_THEME_MAPPING_LIMIT = 4_096

const iconPathSchema = pluginRelativePathSchema.refine(
  (value) => value.toLowerCase().endsWith('.svg'),
  'must point to an SVG file'
)

const iconSlotSchema = z
  .object({
    file: iconPathSchema.optional(),
    folder: iconPathSchema.optional(),
    'folder-open': iconPathSchema.optional()
  })
  .strict()
  .default({})

const associationSchema = z.record(z.string(), iconPathSchema).default({})

const iconThemeArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    icons: iconSlotSchema,
    fileNames: associationSchema,
    fileExtensions: associationSchema,
    folderNames: associationSchema,
    folderNamesExpanded: associationSchema
  })
  .strict()

export type PluginIconThemeArtifact = z.infer<typeof iconThemeArtifactSchema>

export type PluginIconThemeAsset = {
  src: `data:image/svg+xml;base64,${string}`
  monochrome: boolean
}

export type PluginIconThemeRegistration = {
  id: `plugin:${string}/${string}`
  pluginKey: string
  themeId: string
  label: string
  theme: PluginIconThemeArtifact
  assets: Record<string, PluginIconThemeAsset>
}

export type PluginIconThemeParseResult =
  | { ok: true; theme: PluginIconThemeArtifact; assetPaths: string[] }
  | { ok: false; error: string }

type AssociationKind = 'fileNames' | 'fileExtensions' | 'folderNames' | 'folderNamesExpanded'

const ASSOCIATION_KINDS: readonly AssociationKind[] = [
  'fileNames',
  'fileExtensions',
  'folderNames',
  'folderNamesExpanded'
]

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) <= 0x1f) {
      return true
    }
  }
  return false
}

function normalizeAssociations(
  source: Record<string, string>,
  kind: AssociationKind
): { ok: true; entries: Record<string, string> } | { ok: false; error: string } {
  const entries: Record<string, string> = Object.create(null)
  for (const [rawKey, path] of Object.entries(source)) {
    const key = rawKey.toLowerCase()
    if (
      key.length === 0 ||
      key.length > 128 ||
      key === '.' ||
      key === '..' ||
      key.includes('/') ||
      key.includes('\\') ||
      containsAsciiControlCharacter(key)
    ) {
      return { ok: false, error: `${kind} key ${rawKey || '(empty)'} is not a safe name` }
    }
    if (kind === 'fileExtensions' && !/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(key)) {
      return { ok: false, error: `fileExtensions key ${rawKey} is not a portable extension` }
    }
    if (Object.hasOwn(entries, key)) {
      return { ok: false, error: `${kind} contains duplicate case-insensitive key ${rawKey}` }
    }
    entries[key] = path
  }
  return { ok: true, entries }
}

export function parsePluginIconThemeArtifact(raw: string): PluginIconThemeParseResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'icon theme must contain one JSON object' }
  }
  const parsed = iconThemeArtifactSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      error: `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid icon theme'}`
    }
  }

  const theme = parsed.data
  let mappingCount = Object.keys(theme.icons).length
  for (const kind of ASSOCIATION_KINDS) {
    const normalized = normalizeAssociations(theme[kind], kind)
    if (!normalized.ok) {
      return normalized
    }
    theme[kind] = normalized.entries
    mappingCount += Object.keys(normalized.entries).length
  }
  if (mappingCount === 0) {
    return { ok: false, error: 'icon theme must define at least one icon mapping' }
  }
  if (mappingCount > PLUGIN_ICON_THEME_MAPPING_LIMIT) {
    return {
      ok: false,
      error: `icon theme exceeds ${PLUGIN_ICON_THEME_MAPPING_LIMIT} mappings`
    }
  }

  const assetPaths = [
    ...Object.values(theme.icons),
    ...ASSOCIATION_KINDS.flatMap((kind) => Object.values(theme[kind]))
  ]
  return { ok: true, theme, assetPaths: [...new Set(assetPaths)] }
}

export function isPluginIconThemeRegistration(
  value: unknown
): value is PluginIconThemeRegistration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const hasProperty = (candidate: object, key: string): candidate is Record<string, unknown> =>
    Object.hasOwn(candidate, key)

  if (
    !hasProperty(value, 'id') ||
    typeof value.id !== 'string' ||
    !value.id.startsWith('plugin:') ||
    typeof value.pluginKey !== 'string' ||
    typeof value.themeId !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.theme !== 'object' ||
    value.theme === null ||
    typeof value.assets !== 'object' ||
    value.assets === null ||
    Array.isArray(value.assets)
  ) {
    return false
  }
  const parsed = iconThemeArtifactSchema.safeParse(value.theme)
  if (!parsed.success) {
    return false
  }
  const paths = [
    ...Object.values(parsed.data.icons),
    ...ASSOCIATION_KINDS.flatMap((kind) => Object.values(parsed.data[kind]))
  ]
  const assets = value.assets
  return paths.every((path) => {
    if (!hasProperty(assets, path)) {
      return false
    }
    const asset = assets[path]
    if (typeof asset !== 'object' || asset === null || Array.isArray(asset)) {
      return false
    }
    return (
      hasProperty(asset, 'src') &&
      typeof asset.src === 'string' &&
      asset.src.startsWith('data:image/svg+xml;base64,') &&
      typeof asset.monochrome === 'boolean'
    )
  })
}
