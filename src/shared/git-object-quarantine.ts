import { lstat, mkdtemp, readdir, rename, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { isDefinitiveAbsence } from './definitive-filesystem-absence'
import { removeTree } from './windows-transient-lock-removal'

/** Run throwaway merge-tree object writes in a scratch store; alternates retain access to real objects without leaving unreachable loose objects. */

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

// Put tmp_objdir scratch stores inside objects on native/WSL/SSH hosts, matching Git quarantine layout and 2.35+ gc expiry.
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

/** Mirror inherited object-store variables when safe; inherited GIT_OBJECT_DIRECTORY is Git’s primary read/write store. */
export function inheritedObjectStore(
  env: Record<string, string | undefined>
): Pick<GitObjectsDirectory, 'inheritedAlternates'> | undefined {
  if (env.GIT_OBJECT_DIRECTORY !== undefined) {
    return undefined
  }
  const alternates = env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  return alternates ? { inheritedAlternates: alternates } : {}
}

/** Append the real store after inherited alternates, like Git temp stores. Refuse stores with their own alternates to avoid deepening the chain. */
async function quarantineAlternates(objects: GitObjectsDirectory): Promise<string | undefined> {
  const alternatesFile = pathApiForGitPath(objects.hostPath).join(
    objects.hostPath,
    'info',
    'alternates'
  )
  const hasAlternatesFile = await stat(alternatesFile).then(
    () => true,
    (error: unknown) => !isDefinitiveAbsence(error)
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

/** Retain partial-clone fetch packs so future checks do not redownload blobs; merge-tree’s throwaway writes are loose objects. */
async function keepFetchedPacks(scratchHostPath: string, objectsHostPath: string): Promise<void> {
  const path = pathApiForGitPath(objectsHostPath)
  const scratchPackDir = path.join(scratchHostPath, 'pack')
  // Ignore in-progress tmp_pack files; only pack- files are usable.
  const files = (await readdir(scratchPackDir).catch(() => [])).filter((file) =>
    file.startsWith('pack-')
  )
  // Move .idx last because Git discovers packs through their indexes.
  const ordered = [
    ...files.filter((file) => !file.endsWith('.idx')),
    ...files.filter((file) => file.endsWith('.idx'))
  ]
  for (const file of ordered) {
    const target = path.join(objectsHostPath, 'pack', file)
    // Content-hashed pack names can reuse existing files, as Git does.
    const exists = await lstat(target).then(
      () => true,
      () => false
    )
    if (!exists) {
      // Stop on the first failure so no index lands without its pack.
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
        // Bookkeeping failure must not block the user’s command; fall back unquarantined.
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
          // Quarantine starts only after --write-tree support (2.38+), whose gc can prune leftover tmp_* dirs.
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
