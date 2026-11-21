const withFolders = new WeakMap<readonly string[], readonly string[]>()

/** The listing's files, then each folder holding one as `dir/`; one array per listing keeps ranking caches warm. */
export function withFolderPaths(files: readonly string[]): readonly string[] {
  const cached = withFolders.get(files)
  if (cached) {
    return cached
  }
  const folders = new Set<string>()
  for (const file of files) {
    for (let end = file.lastIndexOf('/'); end > 0; end = file.lastIndexOf('/', end - 1)) {
      const folder = file.slice(0, end + 1)
      // A seen folder already added its own parents.
      if (folders.has(folder)) {
        break
      }
      folders.add(folder)
    }
  }
  const result = folders.size > 0 ? [...files, ...folders] : files
  withFolders.set(files, result)
  return result
}

export function isFolderPath(path: string): boolean {
  return path.endsWith('/')
}
