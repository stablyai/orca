export const FILE_EXPLORER_OPEN_TARGETS = ['current-workspace', 'floating-workspace'] as const

export type FileExplorerOpenTarget = (typeof FILE_EXPLORER_OPEN_TARGETS)[number]

export function normalizeFileExplorerOpenTarget(value: unknown): FileExplorerOpenTarget {
  return value === 'floating-workspace' ? value : 'current-workspace'
}
