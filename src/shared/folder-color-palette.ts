export const FOLDER_COLOR_PALETTE = [
  { id: 'magenta', hex: '#C90161' },
  { id: 'violet', hex: '#740363' },
  { id: 'purple-magenta', hex: '#810742' },
  { id: 'orange', hex: '#DD740D' },
  { id: 'orange-magenta', hex: '#CE331A' },
  { id: 'yellow', hex: '#F6CA0F' },
  { id: 'green', hex: '#309027' },
  { id: 'yellow-green', hex: '#B9C303' },
  { id: 'yellow-orange', hex: '#E6972A' },
  { id: 'cyan-blue', hex: '#2F8DC9' },
  { id: 'green-blue', hex: '#17867C' },
  { id: 'purple-blue', hex: '#1E1C64' },
  { id: 'blue', hex: '#3B82F6' }
] as const

export type FolderColorHex = (typeof FOLDER_COLOR_PALETTE)[number]['hex']

const FOLDER_COLOR_HEXES = new Set<string>(FOLDER_COLOR_PALETTE.map(({ hex }) => hex))

export function folderColorOverrideKey(path: string, executionScope?: string | null): string {
  return executionScope ? JSON.stringify([executionScope, path]) : path
}

export function isFolderColorHex(value: unknown): value is FolderColorHex {
  return typeof value === 'string' && FOLDER_COLOR_HEXES.has(value.toUpperCase())
}

export function resolveFolderColorOverride(
  overrides: Readonly<Record<string, string>> | null | undefined,
  path: string
): FolderColorHex | null {
  const value = overrides?.[path]
  const normalized = typeof value === 'string' ? value.toUpperCase() : value
  return isFolderColorHex(normalized) ? normalized : null
}

export function setFolderColorOverride(
  overrides: Readonly<Record<string, string>> | null | undefined,
  path: string,
  color: FolderColorHex | null
): Record<string, FolderColorHex> {
  const next: Record<string, FolderColorHex> = {}
  for (const [entryPath, value] of Object.entries(overrides ?? {})) {
    const validColor = resolveFolderColorOverride({ [entryPath]: value }, entryPath)
    if (validColor) {
      next[entryPath] = validColor
    }
  }

  if (color === null) {
    delete next[path]
  } else {
    next[path] = color
  }
  return next
}
