const withFolders = new WeakMap<readonly string[], readonly string[]>()

// Every folder is one more candidate per keystroke. Real listings hold about one folder per eight files
// (13% in Orca's repo, 3% in node_modules), so a deep, sparse listing is held to that share.
const FILES_PER_FOLDER = 8
const MIN_FOLDER_LIMIT = 256
// Past this many, walking every folder is itself the cost to avoid.
const FULL_WALK_FACTOR = 4

export function folderPathLimit(fileCount: number): number {
  return Math.max(MIN_FOLDER_LIMIT, Math.ceil(fileCount / FILES_PER_FOLDER))
}

/** The listing's files, then the folders holding them as `dir/`; one array per listing keeps ranking caches warm. */
export function withFolderPaths(files: readonly string[]): readonly string[] {
  const cached = withFolders.get(files)
  if (cached) {
    return cached
  }
  const limit = folderPathLimit(files.length)
  const found = everyFolder(files, limit * FULL_WALK_FACTOR)
  const folders = found
    ? found.size > limit
      ? shallowestOf(found, limit)
      : [...found]
    : shallowestByDepth(files, limit)
  const result = folders.length > 0 ? [...files, ...folders] : files
  withFolders.set(files, result)
  return result
}

export function isFolderPath(path: string): boolean {
  return path.endsWith('/')
}

/** Each folder holding a file; null past `ceiling` folders. */
function everyFolder(files: readonly string[], ceiling: number): Set<string> | null {
  const folders = new Set<string>()
  for (const file of files) {
    for (let end = file.lastIndexOf('/'); end > 0; end = file.lastIndexOf('/', end - 1)) {
      const folder = file.slice(0, end + 1)
      // A seen folder already added its own parents.
      if (folders.has(folder)) {
        break
      }
      folders.add(folder)
      if (folders.size > ceiling) {
        return null
      }
    }
  }
  return folders
}

const depthOf = (folder: string): number => {
  let depth = 0
  for (let index = folder.indexOf('/'); index !== -1; index = folder.indexOf('/', index + 1)) {
    depth++
  }
  return depth
}

/** The `limit` shallowest folders; equally deep ones keep listing order. */
function shallowestOf(folders: Set<string>, limit: number): string[] {
  return [...folders]
    .map((folder) => ({ folder, depth: depthOf(folder) }))
    .sort((a, b) => a.depth - b.depth)
    .slice(0, limit)
    .map(({ folder }) => folder)
}

/** The same choice without walking every folder: one depth at a time, stopping once `limit` are taken. */
function shallowestByDepth(files: readonly string[], limit: number): string[] {
  const folders: string[] = []
  const ends = new Int32Array(files.length).fill(-1)
  let active = files.map((_, index) => index)
  while (active.length > 0 && folders.length < limit) {
    const level = new Set<string>()
    const deeper: number[] = []
    for (const index of active) {
      const file = files[index]
      const end = file.indexOf('/', ends[index] + 1)
      if (end === -1) {
        continue
      }
      ends[index] = end
      deeper.push(index)
      if (end > 0) {
        level.add(file.slice(0, end + 1))
      }
    }
    for (const folder of level) {
      if (folders.length === limit) {
        break
      }
      folders.push(folder)
    }
    active = deeper
  }
  return folders
}
