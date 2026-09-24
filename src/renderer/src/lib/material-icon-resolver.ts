// Resolves Material Icon Theme icon ids the same way the VS Code extension does for
// names and extensions. Kept free of asset imports so it can be unit tested.

type IconIdMap = Record<string, string>

export type MaterialIconManifest = {
  iconDefinitions: Record<string, { iconPath: string }>
  file: string
  folder: string
  folderExpanded: string
  fileNames: IconIdMap
  fileExtensions: IconIdMap
  folderNames: IconIdMap
  folderNamesExpanded: IconIdMap
}

function baseName(pathOrName: string): string {
  const lastSlash = Math.max(pathOrName.lastIndexOf('/'), pathOrName.lastIndexOf('\\'))
  return lastSlash >= 0 ? pathOrName.slice(lastSlash + 1) : pathOrName
}

export function resolveMaterialFileIconId(
  manifest: MaterialIconManifest,
  pathOrName: string
): string {
  const lower = baseName(pathOrName).toLowerCase()
  const byName = manifest.fileNames[lower]
  if (byName) {
    return byName
  }
  // Why: longest extension wins, matching VS Code ("app.test.ts" → "test.ts" before "ts").
  const parts = lower.split('.')
  for (let i = 1; i < parts.length; i++) {
    const byExtension = manifest.fileExtensions[parts.slice(i).join('.')]
    if (byExtension) {
      return byExtension
    }
  }
  return manifest.file
}

export function resolveMaterialFolderIconId(
  manifest: MaterialIconManifest,
  pathOrName: string,
  open: boolean
): string {
  const lower = baseName(pathOrName).toLowerCase()
  if (open) {
    return manifest.folderNamesExpanded[lower] ?? manifest.folderExpanded
  }
  return manifest.folderNames[lower] ?? manifest.folder
}

/** File name of the SVG an icon id points at, e.g. "typescript.svg". */
export function materialIconSvgFileName(
  manifest: MaterialIconManifest,
  iconId: string
): string | undefined {
  const iconPath = manifest.iconDefinitions[iconId]?.iconPath
  return iconPath ? baseName(iconPath) : undefined
}
