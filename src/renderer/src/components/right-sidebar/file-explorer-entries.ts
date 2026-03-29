import type { DirEntry } from '../../../../shared/types'

export function shouldIncludeFileExplorerEntry(entry: DirEntry): boolean {
  return entry.name !== '.git' && entry.name !== 'node_modules'
}
