export type DirEntry = {
  name: string
  isDirectory: boolean
}

export function filterEntries(entries: DirEntry[], filter: string): DirEntry[] {
  const q = filter.trim().toLowerCase()
  if (!q) {
    return entries
  }
  return entries.filter((e) => e.name.toLowerCase().includes(q))
}

// Enter-key behavior for the filter input:
//   (a) filtered set has exactly one folder → navigate into it
//       (files alongside it don't block — a folder match wins)
//   (b) filtered set has exactly one file and no folders → fileHint
//   (c) otherwise → noop
export type EnterAction =
  | { type: 'navigate'; name: string }
  | { type: 'fileHint' }
  | { type: 'noop' }

export function decideEnterAction(filteredEntries: DirEntry[]): EnterAction {
  const folders = filteredEntries.filter((e) => e.isDirectory)
  if (folders.length === 1) {
    return { type: 'navigate', name: folders[0].name }
  }
  if (folders.length === 0 && filteredEntries.length > 0) {
    return { type: 'fileHint' }
  }
  return { type: 'noop' }
}

export type EscAction = { type: 'clearFilter' } | { type: 'cancel' }

export function decideEscAction(filter: string): EscAction {
  return filter.length > 0 ? { type: 'clearFilter' } : { type: 'cancel' }
}

export function joinPath(resolvedPath: string, name: string): string {
  return resolvedPath === '/' ? `/${name}` : `${resolvedPath}/${name}`
}
