import { z } from 'zod'
import { pluginRelativePathSchema } from './plugin-manifest-fields'

export const PLUGIN_ICON_THEME_SLOTS = [
  'file',
  'folder',
  'folder-open',
  'sidebar.workspaces',
  'sidebar.source-control',
  'sidebar.search',
  'sidebar.plugins',
  'agent.default',
  'agent.codex',
  'agent.claude'
] as const

const iconPathMapSchema = z.record(z.string(), pluginRelativePathSchema)

const pluginIconThemeArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    icons: z.partialRecord(z.enum(PLUGIN_ICON_THEME_SLOTS), pluginRelativePathSchema).default({}),
    fileNames: iconPathMapSchema.default({}),
    fileExtensions: iconPathMapSchema.default({})
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if (
      Object.keys(artifact.icons).length +
        Object.keys(artifact.fileNames).length +
        Object.keys(artifact.fileExtensions).length >
      512
    ) {
      ctx.addIssue({ code: 'custom', message: 'icon theme exceeds 512 mappings' })
    }
    for (const name of Object.keys(artifact.fileNames)) {
      if (
        name.length === 0 ||
        name.length > 128 ||
        /[\\/]/.test(name) ||
        [...name].some((character) => character.charCodeAt(0) <= 31)
      ) {
        ctx.addIssue({ code: 'custom', path: ['fileNames', name], message: 'unsafe file name' })
      }
    }
    for (const extension of Object.keys(artifact.fileExtensions)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9+._-]{0,31}$/.test(extension)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fileExtensions', extension],
          message: 'unsafe file extension'
        })
      }
    }
  })

export type PluginIconThemeArtifact = {
  icons: Partial<Record<(typeof PLUGIN_ICON_THEME_SLOTS)[number], string>>
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
}

export type PluginIconThemeMetadata = {
  id: `plugin:${string}`
  pluginKey: string
  label: string
}

export type PluginIconThemeImage = {
  dataUrl: string
  rendering: 'image' | 'mask'
}

export type PluginIconThemeRegistration = PluginIconThemeMetadata & {
  icons: Partial<Record<(typeof PLUGIN_ICON_THEME_SLOTS)[number], PluginIconThemeImage>>
  fileNames: Record<string, PluginIconThemeImage>
  fileExtensions: Record<string, PluginIconThemeImage>
}

export function parsePluginIconThemeArtifact(raw: string): PluginIconThemeArtifact {
  const parsed = pluginIconThemeArtifactSchema.parse(JSON.parse(raw))
  const canonicalNames: Record<string, string> = {}
  const canonicalExtensions: Record<string, string> = {}
  for (const [name, path] of Object.entries(parsed.fileNames)) {
    const canonical = name.toLowerCase()
    if (canonicalNames[canonical]) {
      throw new Error(`duplicate case-insensitive file name mapping: ${name}`)
    }
    canonicalNames[canonical] = path
  }
  for (const [extension, path] of Object.entries(parsed.fileExtensions)) {
    const canonical = extension.toLowerCase()
    if (canonicalExtensions[canonical]) {
      throw new Error(`duplicate case-insensitive file extension mapping: ${extension}`)
    }
    canonicalExtensions[canonical] = path
  }
  return { icons: parsed.icons, fileNames: canonicalNames, fileExtensions: canonicalExtensions }
}

const ALLOWED_SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'title',
  'desc',
  'defs',
  'clippath',
  'mask',
  'lineargradient',
  'radialgradient',
  'stop'
])

export function sanitizePluginIconSvg(raw: string): string {
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '')
  if (withoutComments.length === 0 || withoutComments.length > 64 * 1024) {
    throw new Error('SVG icon is empty or exceeds 65536 bytes')
  }
  if (
    /<\?|<!/i.test(withoutComments) ||
    /[\s/]on[a-z][a-z0-9:-]*\s*=/i.test(withoutComments) ||
    /[\s/](?:href|xlink:href)\s*=/i.test(withoutComments) ||
    /[\s/]style\s*=/i.test(withoutComments) ||
    /url\s*\(/i.test(withoutComments) ||
    /[&\\]/.test(withoutComments) ||
    [...withoutComments].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 && code !== 9 && code !== 10 && code !== 13
    })
  ) {
    throw new Error('SVG icon contains active or external content')
  }
  const trimmed = withoutComments.trim()
  if (
    !/^<svg(?:\s[^<>]*)?\/>$/is.test(trimmed) &&
    !/^<svg(?:\s[^<>]*)?>[\s\S]*<\/svg>$/i.test(trimmed)
  ) {
    throw new Error('icon must contain exactly one SVG root')
  }
  const tags = [...trimmed.matchAll(/<\/?\s*([A-Za-z][A-Za-z0-9:-]*)\b/g)]
  if (
    tags.length === 0 ||
    tags[0]?.[1]?.toLowerCase() !== 'svg' ||
    [...trimmed.matchAll(/<\s*svg\b/gi)].length !== 1
  ) {
    throw new Error('icon must have an SVG root element')
  }
  for (const tag of tags) {
    const name = tag[1]!.toLowerCase()
    if (!ALLOWED_SVG_ELEMENTS.has(name)) {
      throw new Error(`SVG element is not allowed: ${name}`)
    }
  }
  return trimmed
}
