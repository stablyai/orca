import React from 'react'
import type { IconNode, IconTheme, IconThemeFileRule, IconThemeFolderRule } from './types'

/**
 * Subset of the VSCode icon theme JSON shape that we parse.
 *
 * The full spec lives at
 * https://code.visualstudio.com/api/extension-guides/file-icon-theme. Fields
 * we don't support yet:
 *   - `languageIds` — Orca doesn't track per-file languages here.
 *   - Font-based icons (`fontCharacter` + `fonts`) — VSCode treats these as a
 *     fallback; modern themes use SVGs exclusively, so we skip them.
 *   - `hidesExplorerArrows` — visual nit, not load-bearing.
 */
export type VscodeIconDefinition = {
  iconPath?: string
  fontCharacter?: string
}

export type VscodeIconThemeShape = {
  iconDefinitions?: Record<string, VscodeIconDefinition>
  file?: string
  folder?: string
  folderExpanded?: string
  rootFolder?: string
  rootFolderExpanded?: string
  fileExtensions?: Record<string, string>
  fileNames?: Record<string, string>
  folderNames?: Record<string, string>
  folderNamesExpanded?: Record<string, string>
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
}

export type SvgIconRegistry = {
  /**
   * Returns the URL to render for a given iconPath (the relative path as it
   * appears in `iconDefinitions[*].iconPath`). Should return `null` if the
   * asset is missing — the parser uses the file fallback in that case.
   */
  resolveIconUrl: (iconPath: string) => string | null
}

const SVG_ICON_DISPLAY_NAME = 'SvgUrlIcon'

/**
 * Render an SVG asset by URL. Used by both the parser (for VSCode-shaped
 * themes) and the importer (for user-supplied themes from disk). The image
 * is decoded async and tagged aria-hidden so screen readers skip it — the
 * file/folder name beside it is the accessible label.
 */
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
  Icon.displayName = SVG_ICON_DISPLAY_NAME
  return Icon
}

function definitionToIcon(
  defs: Record<string, VscodeIconDefinition>,
  defId: string | undefined,
  registry: SvgIconRegistry
): IconNode | null {
  if (!defId) {
    return null
  }
  const def = defs[defId]
  if (!def?.iconPath) {
    return null
  }
  const url = registry.resolveIconUrl(def.iconPath)
  if (!url) {
    return null
  }
  return createSvgUrlIcon(url)
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

  const fileDefId = overrides?.file ?? json.file
  const folderDefId = overrides?.folder ?? json.folder
  const folderExpandedDefId = overrides?.folderExpanded ?? json.folderExpanded ?? folderDefId

  const defaultFileIcon = definitionToIcon(defs, fileDefId, registry)
  const defaultFolderClosed = definitionToIcon(defs, folderDefId, registry)
  const defaultFolderOpen = definitionToIcon(defs, folderExpandedDefId, registry)

  if (!defaultFileIcon || !defaultFolderClosed || !defaultFolderOpen) {
    return null
  }

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

  const fileRules: IconThemeFileRule[] = []
  // Filename rules first (more specific). Lower-cased for case-insensitive match.
  for (const [name, defId] of Object.entries(fileNames)) {
    const icon = definitionToIcon(defs, defId, registry)
    if (icon) {
      fileRules.push({ filename: name.toLowerCase(), icon })
    }
  }
  for (const [ext, defId] of Object.entries(fileExtensions)) {
    const icon = definitionToIcon(defs, defId, registry)
    if (icon) {
      fileRules.push({ extension: ext.toLowerCase(), icon })
    }
  }

  const folderRules: IconThemeFolderRule[] = []
  const folderNameKeys = new Set([...Object.keys(folderNames), ...Object.keys(folderNamesExpanded)])
  for (const name of folderNameKeys) {
    const closed = definitionToIcon(defs, folderNames[name], registry)
    const open = definitionToIcon(defs, folderNamesExpanded[name], registry)
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
    monochrome: false,
    defaultFileIcon,
    defaultFolder: { closed: defaultFolderClosed, open: defaultFolderOpen },
    fileRules,
    folderRules
  }
}
