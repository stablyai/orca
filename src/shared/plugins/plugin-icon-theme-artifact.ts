import { z } from 'zod'
import { pluginRelativePathSchema } from './plugin-manifest-fields'
import { pluginContentIdSchema } from './plugin-theme-artifact'

export const PLUGIN_ICON_THEME_SLOTS = ['file', 'folder', 'folder-open'] as const
export type PluginIconThemeSlot = (typeof PLUGIN_ICON_THEME_SLOTS)[number]

const ICON_THEME_MAPPING_LIMIT = 512

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 31)
}
const iconSlotSchema = z.enum(PLUGIN_ICON_THEME_SLOTS)

const fileNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((name) => !/[\\/]/.test(name) && !hasControlCharacter(name), 'unsafe file name')
const fileExtensionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+._-]{0,31}$/)

// Why: z.record drops an own `__proto__` key, but a file may legitimately be named that.
function ownKeyRecord<Value>(keySchema: z.ZodType<string>, valueSchema: z.ZodType<Value>) {
  return z.unknown().transform((raw, ctx) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      ctx.addIssue({ code: 'custom', message: 'expected an object' })
      return z.NEVER
    }
    const result: Record<string, Value> = Object.create(null)
    for (const [key, entry] of Object.entries(raw)) {
      const parsedKey = keySchema.safeParse(key)
      const parsedValue = valueSchema.safeParse(entry)
      if (!parsedKey.success || !parsedValue.success) {
        ctx.addIssue({ code: 'custom', message: `invalid entry: ${key}` })
        return z.NEVER
      }
      result[key] = parsedValue.data
    }
    return result
  })
}

const pluginIconThemeArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    icons: z.partialRecord(iconSlotSchema, pluginRelativePathSchema).default({}),
    fileNames: ownKeyRecord(fileNameSchema, pluginRelativePathSchema).default({}),
    fileExtensions: ownKeyRecord(fileExtensionSchema, pluginRelativePathSchema).default({})
  })
  .strict()

export type PluginIconThemeArtifact = {
  icons: Partial<Record<PluginIconThemeSlot, string>>
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
}

/** Lowercases name and extension keys so lookups match on case-insensitive filesystems. */
export function parsePluginIconThemeArtifact(raw: string): PluginIconThemeArtifact {
  const parsed = pluginIconThemeArtifactSchema.parse(JSON.parse(raw))
  const lowercaseKeys = (entries: Record<string, string>, label: string) => {
    // Why: a null prototype keeps keys like `constructor` and `__proto__` plain data.
    const result: Record<string, string> = Object.create(null)
    for (const [key, path] of Object.entries(entries)) {
      const canonical = key.toLowerCase()
      if (Object.hasOwn(result, canonical)) {
        throw new Error(`duplicate ${label}: ${key}`)
      }
      result[canonical] = path
    }
    return result
  }
  const artifact = {
    icons: parsed.icons,
    fileNames: lowercaseKeys(parsed.fileNames, 'file name'),
    fileExtensions: lowercaseKeys(parsed.fileExtensions, 'file extension')
  }
  const mappings =
    Object.keys(artifact.icons).length +
    Object.keys(artifact.fileNames).length +
    Object.keys(artifact.fileExtensions).length
  if (mappings > ICON_THEME_MAPPING_LIMIT) {
    throw new Error(`icon theme exceeds ${ICON_THEME_MAPPING_LIMIT} mappings`)
  }
  return artifact
}

export const PLUGIN_ICON_SVG_MAX_BYTES = 64 * 1024
export const PLUGIN_ICON_THEME_MAX_SVGS = 512

/** A cheap host-side gate; the renderer parses each SVG with the browser's XML parser and keeps
 *  only allowlisted elements and attributes before drawing it as an image. */
export function isPlausiblePluginIconSvg(text: string): boolean {
  const svg = text.trim()
  return (
    svg.length > 0 &&
    svg.length <= PLUGIN_ICON_SVG_MAX_BYTES &&
    /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/i.test(svg) &&
    !/<!(?:DOCTYPE|ENTITY)/i.test(svg)
  )
}

const svgIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(PLUGIN_ICON_THEME_MAX_SVGS - 1)

const pluginIconThemeMetadataSchema = z.object({
  id: pluginContentIdSchema,
  pluginKey: z.string(),
  label: z.string()
})

/** Each distinct SVG is sent once; the maps point into `svgs` so rows never repeat image data. */
const pluginIconThemeRegistrationObjectSchema = pluginIconThemeMetadataSchema.extend({
  svgs: z.array(z.string().max(PLUGIN_ICON_SVG_MAX_BYTES)).max(PLUGIN_ICON_THEME_MAX_SVGS),
  icons: z.partialRecord(iconSlotSchema, svgIndexSchema),
  fileNames: ownKeyRecord(z.string(), svgIndexSchema),
  fileExtensions: ownKeyRecord(z.string(), svgIndexSchema)
})
const pluginIconThemeRegistrationSchema = pluginIconThemeRegistrationObjectSchema.refine(
  (theme) =>
    [
      ...Object.values(theme.icons),
      ...Object.values(theme.fileNames),
      ...Object.values(theme.fileExtensions)
    ].every((index) => index < theme.svgs.length),
  'icon index outside svgs'
)

export type PluginIconThemeMetadata = z.infer<typeof pluginIconThemeMetadataSchema>
export type PluginIconThemeRegistration = z.infer<typeof pluginIconThemeRegistrationSchema>

export function isPluginIconThemeMetadata(value: unknown): value is PluginIconThemeMetadata {
  return pluginIconThemeMetadataSchema.safeParse(value).success
}

export function isPluginIconThemeRegistration(
  value: unknown
): value is PluginIconThemeRegistration {
  return pluginIconThemeRegistrationSchema.safeParse(value).success
}
