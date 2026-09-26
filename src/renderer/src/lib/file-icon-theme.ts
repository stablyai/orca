import type {
  PluginIconThemeAsset,
  PluginIconThemeRegistration
} from '../../../shared/plugins/plugin-icon-theme-artifact'

type FileIconThemeTarget = {
  name: string
  isDirectory: boolean
  isExpanded: boolean
}

function extensionCandidates(name: string): string[] {
  const normalized = name.toLowerCase()
  const parts = (normalized.startsWith('.') ? normalized.slice(1) : normalized).split('.')
  if (parts.length < 2 || parts.at(-1) === '') {
    return []
  }
  return parts.slice(1).map((_, index) => parts.slice(index + 1).join('.'))
}

function ownMappingValue(entries: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(entries, key) ? entries[key] : undefined
}

export function resolveFileIconThemeAsset(
  registration: PluginIconThemeRegistration,
  target: FileIconThemeTarget
): PluginIconThemeAsset | null {
  const name = target.name.toLowerCase()
  const { theme, assets } = registration
  let path: string | undefined

  if (target.isDirectory) {
    path = target.isExpanded
      ? (ownMappingValue(theme.folderNamesExpanded, name) ??
        ownMappingValue(theme.folderNames, name) ??
        theme.icons['folder-open'] ??
        theme.icons.folder)
      : (ownMappingValue(theme.folderNames, name) ?? theme.icons.folder)
  } else {
    path = ownMappingValue(theme.fileNames, name)
    for (const extension of extensionCandidates(name)) {
      path ??= ownMappingValue(theme.fileExtensions, extension)
    }
    path ??= theme.icons.file
  }

  return path ? (assets[path] ?? null) : null
}
