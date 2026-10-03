import { lstat, mkdtemp, readdir, rename, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { removeTree } from './windows-transient-lock-removal'

/**
 * Runs a Git command whose object writes are throwaway (`merge-tree --write-tree`
 * only wants its stdout) against a scratch object directory, so nothing it
 * writes lands in the repository's real object store as unreachable loose
 * objects. Reads still see every real object through the alternates variable.
 */

export type GitObjectQuarantineEnv = {
  GIT_OBJECT_DIRECTORY: string
  GIT_ALTERNATE_OBJECT_DIRECTORIES: string
}

export type GitObjectsDirectory = {
  /** How this process spells `objects/` when creating and deleting the scratch dir. */
  hostPath: string
  /** How the Git child spells the same directory (differs for WSL). */
  gitPath: string
  /** GIT_ALTERNATE_OBJECT_DIRECTORIES as Git would inherit it unquarantined. */
  inheritedAlternates?: string
}

export type GitObjectQuarantine = {
  run: <T>(command: (env: GitObjectQuarantineEnv | undefined) => Promise<T>) => Promise<T>
}

// Why inside `objects/` with a `tmp_objdir` prefix: that is where Git puts its own
// quarantine dirs, it is on the Git host for native, WSL and SSH alike, and
// `git gc` (2.35+) expires stale `tmp_*` dirs too.
export const GIT_OBJECT_QUARANTINE_DIR_PREFIX = 'tmp_objdir-orca-merge-tree-'

/** Decided by path syntax, not by platform: a Windows main process drives WSL Git. */
export function pathApiForGitPath(value: string): typeof posix {
  return isWindowsAbsolutePathLike(value) ? win32 : posix
}

// Why: Git splits this variable on `:` (`;` for Git for Windows) and C-unquotes a leading `"`.
function quoteAlternate(path: string, windowsGit: boolean): string {
  const needsQuoting = windowsGit ? /[;"]/ : /[:"\\]/
  if (!needsQuoting.test(path)) {
    return path
  }
  return `"${path.replace(/[\\"]/g, (char) => `\\${char}`)}"`
}

/**
 * Which inherited object-store variables a quarantine can mirror, as `GitObjectsDirectory` fields;
 * undefined when it cannot: an inherited GIT_OBJECT_DIRECTORY is the store Git reads and writes.
 */
export function inheritedObjectStore(
  env: Record<string, string | undefined>
): Pick<GitObjectsDirectory, 'inheritedAlternates'> | undefined {
  if (env.GIT_OBJECT_DIRECTORY !== undefined) {
    return undefined
  }
  const alternates = env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  return alternates ? { inheritedAlternates: alternates } : {}
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

/**
 * The alternates for a quarantined run, or undefined to run unquarantined. Inherited value first,
 * as Git's own temporary object dirs append. A real store with its own alternates is not
 * quarantined: as an alternate instead of the primary, its chain would link one level deeper.
 */
async function quarantineAlternates(objects: GitObjectsDirectory): Promise<string | undefined> {
  const alternatesFile = pathApiForGitPath(objects.hostPath).join(
    objects.hostPath,
    'info',
    'alternates'
  )
  const hasAlternatesFile = await stat(alternatesFile).then(
    () => true,
    (error: unknown) => !isMissingFileError(error)
  )
  if (hasAlternatesFile) {
    return undefined
  }
  const windowsGit = isWindowsAbsolutePathLike(objects.gitPath)
  const realStore = quoteAlternate(objects.gitPath, windowsGit)
  return objects.inheritedAlternates
    ? `${objects.inheritedAlternates}${windowsGit ? ';' : ':'}${realStore}`
    : realStore
}

/**
 * A partial clone fetches missing blobs on demand, and Git files that download
 * as a pack in the scratch dir. Keep those packs so the next check does not
 * download the same blobs again; merge-tree's own writes are loose objects.
 */
async function keepFetchedPacks(scratchHostPath: string, objectsHostPath: string): Promise<void> {
  const path = pathApiForGitPath(objectsHostPath)
  const scratchPackDir = path.join(scratchHostPath, 'pack')
  // Why `pack-` only: Git's in-progress `tmp_pack_*` files are not usable packs.
  const files = (await readdir(scratchPackDir).catch(() => [])).filter((file) =>
    file.startsWith('pack-')
  )
  // Why `.idx` last: Git finds a pack through its index, so the rest must be in place first.
  const ordered = [
    ...files.filter((file) => !file.endsWith('.idx')),
    ...files.filter((file) => file.endsWith('.idx'))
  ]
  for (const file of ordered) {
    const target = path.join(objectsHostPath, 'pack', file)
    // Why skip: pack names are content hashes, and Git also leaves an existing file in place.
    const exists = await lstat(target).then(
      () => true,
      () => false
    )
    if (!exists) {
      // Why no per-file catch: stopping at the first failure keeps an index from landing without its pack.
      await rename(path.join(scratchPackDir, file), target)
    }
  }
}

/** Resolves the objects dir once per quarantine; each run gets its own scratch dir. */
export function createGitObjectQuarantine(
  resolveObjectsDirectory: () => Promise<GitObjectsDirectory | undefined>
): GitObjectQuarantine {
  let objectsDirectory: Promise<GitObjectsDirectory | undefined> | undefined
  const resolveOnce = (): Promise<GitObjectsDirectory | undefined> => {
    objectsDirectory ??= resolveObjectsDirectory().catch(() => undefined)
    return objectsDirectory
  }

  return {
    async run(command) {
      const objects = await resolveOnce()
      const alternates = objects ? await quarantineAlternates(objects) : undefined
      let scratchHostPath: string | undefined
      if (objects && alternates !== undefined) {
        const path = pathApiForGitPath(objects.hostPath)
        scratchHostPath = await mkdtemp(
          path.join(objects.hostPath, GIT_OBJECT_QUARANTINE_DIR_PREFIX)
        ).catch(() => undefined)
      }
      if (!objects || alternates === undefined || !scratchHostPath) {
        // Why: bookkeeping must not block the user's action; run unquarantined.
        return command(undefined)
      }
      try {
        return await command({
          GIT_OBJECT_DIRECTORY: pathApiForGitPath(objects.gitPath).join(
            objects.gitPath,
            pathApiForGitPath(scratchHostPath).basename(scratchHostPath)
          ),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates
        })
      } finally {
        await keepFetchedPacks(scratchHostPath, objects.hostPath).catch((error: unknown) => {
          console.warn('[git-object-quarantine] could not keep a fetched pack', error)
        })
        await removeTree(scratchHostPath).catch((error: unknown) => {
          // Why: quarantined only once this host's Git ran --write-tree (2.38+), whose gc prunes `tmp_*`.
          console.warn(
            '[git-object-quarantine] could not remove scratch dir',
            scratchHostPath,
            error
          )
        })
      }
    }
  }
}
