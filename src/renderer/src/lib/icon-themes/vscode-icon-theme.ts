import React from 'react'
import { File, Folder, FolderOpen } from 'lucide-react'
import type { IconNode, IconTheme, IconThemeFileRule, IconThemeFolderRule } from './types'

/**
 * Subset of the VSCode icon theme JSON shape that we parse.
 *
 * The full spec lives at
 * https://code.visualstudio.com/api/extension-guides/file-icon-theme.
 */
export type VscodeIconDefinition = {
  iconPath?: string
  fontCharacter?: string
  fontColor?: string
  fontId?: string
  fontSize?: string
}

export type VscodeFontSrc = { path: string; format: string }
export type VscodeFont = {
  id: string
  src: VscodeFontSrc[]
  weight?: string
  style?: string
  size?: string
}

export type VscodeIconThemeShape = {
  iconDefinitions?: Record<string, VscodeIconDefinition>
  fonts?: VscodeFont[]
  file?: string
  folder?: string
  folderExpanded?: string
  rootFolder?: string
  rootFolderExpanded?: string
  fileExtensions?: Record<string, string>
  fileNames?: Record<string, string>
  folderNames?: Record<string, string>
  folderNamesExpanded?: Record<string, string>
  languageIds?: Record<string, string>
  light?: VscodeIconThemeOverrides
  highContrast?: VscodeIconThemeOverrides
}

export type VscodeIconThemeOverrides = {
  file?: string
  folder?: string
  folderExpanded?: string
  rootFolder?: string
  rootFolderExpanded?: string
  fileExtensions?: Record<string, string>
  fileNames?: Record<string, string>
  folderNames?: Record<string, string>
  folderNamesExpanded?: Record<string, string>
  languageIds?: Record<string, string>
}

export type SvgIconRegistry = {
  /**
   * Returns the URL to render for a given iconPath (the relative path as it
   * appears in `iconDefinitions[*].iconPath`). Should return `null` if the
   * asset is missing — the parser uses the file fallback in that case.
   */
  resolveIconUrl: (iconPath: string) => string | null
}

function createSvgUrlIcon(url: string): IconNode {
  const Icon: IconNode = ({ className, style, ...rest }) =>
    React.createElement('img', {
      src: url,
      className,
      style,
      alt: '',
      'aria-hidden': true,
      draggable: false,
      ...rest
    })
  Icon.displayName = 'SvgUrlIcon'
  return Icon
}

function createFontIcon(
  fontFamily: string,
  character: string,
  color?: string,
  fontSize?: string
): IconNode {
  const Icon: IconNode = ({ className, style, ...rest }) =>
    React.createElement(
      'span',
      {
        className,
        'aria-hidden': true,
        style: {
          fontFamily,
          fontStyle: 'normal',
          fontWeight: 'normal',
          textDecoration: 'none',
          textRendering: 'auto',
          WebkitFontSmoothing: 'antialiased',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
          ...(color ? { color } : {}),
          ...(fontSize ? { fontSize } : {}),
          ...style
        },
        ...rest
      },
      character
    )
  Icon.displayName = 'FontIcon'
  return Icon
}

// Why: each imported font-based theme needs a unique @font-face injected once.
// We track which CSS family names we've already injected to avoid duplicates.
const injectedFontFaces = new Map<string, HTMLStyleElement>()

type FontRegistry = {
  fontIdToCssFamily: Map<string, string>
  fontIdToSize: Map<string, string>
}

const ALLOWED_FONT_FORMATS = new Set([
  'woff',
  'woff2',
  'truetype',
  'opentype',
  'embedded-opentype',
  'svg'
])

function sanitizeCssString(value: string): string {
  return value.replace(/[\\";{}()]/g, '')
}

function injectFontFaces(themeId: string, fonts: VscodeFont[]): FontRegistry {
  const fontIdToCssFamily = new Map<string, string>()
  const fontIdToSize = new Map<string, string>()
  for (const font of fonts) {
    const cssFamily = `orca-icon-${themeId}-${sanitizeCssString(font.id)}`
    fontIdToCssFamily.set(font.id, cssFamily)
    if (font.size) {
      fontIdToSize.set(font.id, font.size)
    }
    if (injectedFontFaces.has(cssFamily)) {
      continue
    }
    const srcParts = font.src
      .filter((s) => ALLOWED_FONT_FORMATS.has(s.format))
      .map((s) => {
        const safePath = s.path.startsWith('data:') ? s.path : sanitizeCssString(s.path)
        return `url("${safePath}") format("${sanitizeCssString(s.format)}")`
      })
      .join(', ')
    if (!srcParts) {
      continue
    }
    const css = `@font-face {
  font-family: "${cssFamily}";
  src: ${srcParts};
  font-weight: ${sanitizeCssString(font.weight ?? 'normal')};
  font-style: ${sanitizeCssString(font.style ?? 'normal')};
}`
    const styleEl = document.createElement('style')
    styleEl.textContent = css
    document.head.appendChild(styleEl)
    injectedFontFaces.set(cssFamily, styleEl)
  }
  return { fontIdToCssFamily, fontIdToSize }
}

export function removeInjectedFontFaces(themeId: string): void {
  for (const [key, styleEl] of injectedFontFaces) {
    if (key.startsWith(`orca-icon-${themeId}-`)) {
      styleEl.remove()
      injectedFontFaces.delete(key)
    }
  }
}

function definitionToIcon(
  defs: Record<string, VscodeIconDefinition>,
  defId: string | undefined,
  registry: SvgIconRegistry,
  fontRegistry?: FontRegistry
): IconNode | null {
  if (!defId) {
    return null
  }
  const def = defs[defId]
  if (!def) {
    return null
  }

  if (def.iconPath) {
    const url = registry.resolveIconUrl(def.iconPath)
    if (url) {
      return createSvgUrlIcon(url)
    }
  }

  if (def.fontCharacter && fontRegistry) {
    const { fontIdToCssFamily, fontIdToSize } = fontRegistry
    const fontId = def.fontId ?? fontIdToCssFamily.keys().next().value
    if (!fontId) {
      return null
    }
    const cssFamily = fontIdToCssFamily.get(fontId)
    if (!cssFamily) {
      return null
    }
    const char = def.fontCharacter.replace(/\\([0-9a-fA-F]+)/g, (_m, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    const fontSize = def.fontSize ?? fontIdToSize.get(fontId)
    return createFontIcon(`"${cssFamily}"`, char, def.fontColor, fontSize)
  }

  return null
}

export type ParseVscodeOptions = {
  id: string
  name: string
  description?: string
  /**
   * When `true`, generate the light-mode variant of the theme. If the JSON
   * has no `light` block, returns `null` — callers can skip registering a
   * light variant in that case.
   */
  variant?: 'default' | 'light'
}

/**
 * Translate a VSCode-shaped iconTheme JSON to Orca's `IconTheme` shape. The
 * `light` variant merges overrides into a fresh theme.
 *
 * Returns `null` when the requested variant has nothing to render — for
 * example, asking for `light` on a theme with no `light` block.
 */
export function parseVscodeIconTheme(
  json: VscodeIconThemeShape,
  registry: SvgIconRegistry,
  options: ParseVscodeOptions
): IconTheme | null {
  const defs = json.iconDefinitions ?? {}
  const variant = options.variant ?? 'default'
  const overrides = variant === 'light' ? json.light : undefined
  if (variant === 'light' && !overrides) {
    return null
  }

  const fontReg = json.fonts?.length ? injectFontFaces(options.id, json.fonts) : undefined

  const fileDefId = overrides?.file ?? json.file
  const folderDefId = overrides?.folder ?? json.folder
  const folderExpandedDefId = overrides?.folderExpanded ?? json.folderExpanded ?? folderDefId

  const defaultFileIcon = definitionToIcon(defs, fileDefId, registry, fontReg) ?? File
  const defaultFolderClosed = definitionToIcon(defs, folderDefId, registry, fontReg) ?? Folder
  const defaultFolderOpen =
    definitionToIcon(defs, folderExpandedDefId, registry, fontReg) ?? FolderOpen

  const fileExtensions: Record<string, string> = {
    ...json.fileExtensions,
    ...overrides?.fileExtensions
  }
  const fileNames: Record<string, string> = {
    ...json.fileNames,
    ...overrides?.fileNames
  }
  const folderNames: Record<string, string> = {
    ...json.folderNames,
    ...overrides?.folderNames
  }
  const folderNamesExpanded: Record<string, string> = {
    ...json.folderNamesExpanded,
    ...overrides?.folderNamesExpanded
  }
  const languageIds: Record<string, string> = {
    ...json.languageIds,
    ...overrides?.languageIds
  }

  const fileRules: IconThemeFileRule[] = []
  for (const [name, defId] of Object.entries(fileNames)) {
    const icon = definitionToIcon(defs, defId, registry, fontReg)
    if (icon) {
      fileRules.push({ filename: name.toLowerCase(), icon })
    }
  }
  for (const [ext, defId] of Object.entries(fileExtensions)) {
    const icon = definitionToIcon(defs, defId, registry, fontReg)
    if (icon) {
      fileRules.push({ extension: ext.toLowerCase(), icon })
    }
  }
  // languageIds as extension fallbacks (many themes only declare these)
  for (const [langId, defId] of Object.entries(languageIds)) {
    const icon = definitionToIcon(defs, defId, registry, fontReg)
    if (icon) {
      fileRules.push({ extension: langId.toLowerCase(), icon })
    }
  }

  const folderRules: IconThemeFolderRule[] = []
  const folderNameKeys = new Set([...Object.keys(folderNames), ...Object.keys(folderNamesExpanded)])
  for (const name of folderNameKeys) {
    const closed = definitionToIcon(defs, folderNames[name], registry, fontReg)
    const open = definitionToIcon(defs, folderNamesExpanded[name], registry, fontReg)
    if (closed || open) {
      folderRules.push({
        name: name.toLowerCase(),
        closed: closed ?? open!,
        open: open ?? closed!
      })
    }
  }

  return {
    id: options.id,
    name: options.name,
    description: options.description,
    monochrome: !!fontReg && !Object.values(defs).some((d) => d?.fontColor),
    defaultFileIcon,
    defaultFolder: { closed: defaultFolderClosed, open: defaultFolderOpen },
    fileRules,
    folderRules
  }
}
