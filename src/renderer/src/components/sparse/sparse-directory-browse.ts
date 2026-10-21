import type { DirEntry } from '../../../../shared/filesystem-entry-types'

const HIDDEN_BROWSE_DIRECTORIES = new Set(['.git', 'node_modules'])

/** Directories a sparse preset can name, in display order. Hidden folders and
 *  heavy tool caches are dropped because no cone-mode preset targets them. */
export function listBrowsableDirectories(entries: DirEntry[]): string[] {
  return entries
    .filter(
      (entry) =>
        entry.isDirectory &&
        !entry.name.startsWith('.') &&
        !HIDDEN_BROWSE_DIRECTORIES.has(entry.name)
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
}

export function joinSparseBrowsePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/** Cumulative breadcrumb segments for `apps/web` → apps, apps/web. */
export function getSparseBrowseTrail(relativePath: string): { name: string; path: string }[] {
  if (!relativePath) {
    return []
  }
  const trail: { name: string; path: string }[] = []
  let prefix = ''
  for (const name of relativePath.split('/')) {
    prefix = joinSparseBrowsePath(prefix, name)
    trail.push({ name, path: prefix })
  }
  return trail
}
