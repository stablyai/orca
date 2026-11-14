import { z } from 'zod'
import { pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import { pluginFieldDoc, pluginPathFieldDoc } from '../manifest/plugin-schema-field-docs'

/** First release that registers `contributes.fonts`. */
export const PLUGIN_FONTS_SINCE = '1.4.253'
const SINCE = PLUGIN_FONTS_SINCE

// Why these caps: a family is regular/bold/italic/bold-italic, or one or two variable files; a
// Latin WOFF2 face is 20-300 KB and a symbol-patched monospace face about 1.2 MB.
export const PLUGIN_FONT_LIMIT = 8
export const PLUGIN_FONT_FACE_LIMIT = 8
export const PLUGIN_FONT_FILE_MAX_BYTES = 2 * 1024 * 1024
export const PLUGIN_FONTS_TOTAL_MAX_BYTES = 8 * 1024 * 1024

export type PluginFontFormat = 'woff' | 'woff2'

export const PLUGIN_FONT_MIME: Record<PluginFontFormat, string> = {
  woff: 'font/woff',
  woff2: 'font/woff2'
}

// Why WOFF only: they are the web formats, and the renderer's font loader sanitizes every web
// font before parsing. TTF, OTF and collections add nothing a plugin cannot convert to WOFF2.
const FONT_SIGNATURES: Record<PluginFontFormat, readonly number[]> = {
  woff: [0x77, 0x4f, 0x46, 0x46], // wOFF
  woff2: [0x77, 0x4f, 0x46, 0x32] // wOF2
}
// The wrapped font's flavor (bytes 4-7): TrueType or CFF. A collection (`ttcf`) is refused.
const FONT_FLAVORS: readonly (readonly number[])[] = [
  [0x00, 0x01, 0x00, 0x00],
  [0x4f, 0x54, 0x54, 0x4f], // OTTO
  [0x74, 0x72, 0x75, 0x65] // true
]

/** The format a file's extension claims, or null when it is not a web font. */
function claimedFontFormat(path: string): PluginFontFormat | null {
  const lower = path.toLowerCase()
  return lower.endsWith('.woff2') ? 'woff2' : lower.endsWith('.woff') ? 'woff' : null
}

/** Its format when the extension, signature and flavor agree; nothing past byte 8 is read. */
export function pluginFontFormat(path: string, bytes: Uint8Array): PluginFontFormat | null {
  const format = claimedFontFormat(path)
  const flavorOk = FONT_FLAVORS.some((flavor) =>
    flavor.every((value, index) => bytes[4 + index] === value)
  )
  return format &&
    flavorOk &&
    FONT_SIGNATURES[format].every((value, index) => bytes[index] === value)
    ? format
    : null
}

// Why ASCII and no quotes, commas or parentheses: the name lands inside a quoted CSS font-family
// list, and look-alike letters must not pass for an installed font in the picker.
const FONT_FAMILY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 _.-]{0,46}[A-Za-z0-9])?$/
const FONT_WEIGHT_RE = /^(?:[1-9]\d{0,2}|1000)(?: (?:[1-9]\d{0,2}|1000))?$/

const pluginFontFaceSchema = z
  .object({
    path: pluginRelativePathSchema
      .regex(/\.woff2?$/i, 'must be a .woff or .woff2 file')
      .meta(
        pluginPathFieldDoc(
          `WOFF or WOFF2 file, at most ${PLUGIN_FONT_FILE_MAX_BYTES / 1024 / 1024} MB; its first bytes must match its extension. TTF, OTF and font collections are refused.`,
          SINCE,
          ['fonts/Geist-Variable.woff2']
        )
      ),
    weight: z
      .string()
      .regex(FONT_WEIGHT_RE, 'must be a weight from 1 to 1000, or a range such as "100 900"')
      .refine((value) => {
        const [low, high = low] = value.split(' ').map(Number)
        return low <= high
      }, 'must list the lower weight first')
      .optional()
      .meta(
        pluginFieldDoc(
          'CSS weight this file draws, or a range for a variable font. Defaults to `400`.',
          SINCE,
          ['400', '100 900']
        )
      ),
    style: z
      .enum(['normal', 'italic'])
      .optional()
      .meta(pluginFieldDoc('Whether this file is the italic face. Defaults to `normal`.', SINCE))
  })
  .strict()
  .meta({ id: 'FontFaceContribution', description: 'One file of a font family.' })

export const pluginFontContributionSchema = z
  .object({
    family: z
      .string()
      .regex(
        FONT_FAMILY_RE,
        'must be 1-48 ASCII letters, digits, spaces, dots, dashes or underscores'
      )
      .meta(
        pluginFieldDoc(
          'Family name shown in the font pickers. Orca adds the plugin id, so a plugin font never replaces an installed or built-in font of the same name.',
          SINCE,
          ['Geist']
        )
      ),
    faces: z
      .array(pluginFontFaceSchema)
      .min(1)
      .max(PLUGIN_FONT_FACE_LIMIT)
      .meta(
        pluginFieldDoc(
          `The family's files, at most ${PLUGIN_FONT_FACE_LIMIT}. All of a plugin's font files together may be at most ${PLUGIN_FONTS_TOTAL_MAX_BYTES / 1024 / 1024} MB.`,
          SINCE
        )
      )
  })
  .strict()
  .meta({
    id: 'FontContribution',
    description:
      'A font family the user can pick for the terminal, editor or interface. It applies only once picked.'
  })

export type PluginFontContribution = z.infer<typeof pluginFontContributionSchema>

/** For clients re-checking a host's list: the same rules the manifest enforces. */
export function isPluginFontFamilyLabel(family: string): boolean {
  return FONT_FAMILY_RE.test(family)
}

export function isPluginFontWeight(weight: string): boolean {
  return FONT_WEIGHT_RE.test(weight)
}

/** The CSS family Orca registers: the plugin key keeps it from matching any other font. */
export function pluginFontFamilyName(pluginKey: string, family: string): string {
  return `${family} (${pluginKey})`
}

/** True when `fontFamily` is a family the plugin registers, so its removal can reset the choice. */
export function isPluginFontFamilyOf(fontFamily: string | undefined, pluginKey: string): boolean {
  return fontFamily?.trim().toLowerCase().endsWith(` (${pluginKey})`) === true
}

/** True when `fontFamily` has the shape `pluginFontFamilyName` gives, whichever plugin it names. */
export function isPluginFontFamilyName(fontFamily: string): boolean {
  return / \([a-z0-9-]+\.[a-z0-9-]+\)$/i.test(fontFamily.trim())
}

/** The image-protocol slot of one font file: `font-<family index>-<face index>`. */
export function pluginFontSlot(familyIndex: number, faceIndex: number): string {
  return `font-${familyIndex}-${faceIndex}`
}

export function parsePluginFontSlot(
  slot: string
): { familyIndex: number; faceIndex: number } | null {
  const match = /^font-(\d)-(\d)$/.exec(slot)
  return match ? { familyIndex: Number(match[1]), faceIndex: Number(match[2]) } : null
}
