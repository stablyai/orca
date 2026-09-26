import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from './cross-platform-path'

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
  /** How the process creating and deleting the scratch dir spells `objects/`. */
  hostPath: string
  /** How the Git child spells the same directory (differs for WSL). */
  gitPath: string
}

export type GitObjectQuarantineHost = {
  resolveObjectsDirectory: () => Promise<GitObjectsDirectory | undefined>
  /** mkdtemp semantics: `prefix` plus a unique suffix, returns the created path. */
  makeTempDirectory: (prefix: string) => Promise<string>
  removeDirectory: (hostPath: string) => Promise<void>
}

export type GitObjectQuarantine = {
  run: <T>(command: (env: GitObjectQuarantineEnv | undefined) => Promise<T>) => Promise<T>
}

// Why inside `objects/` with a `tmp_objdir` prefix: that is where Git puts its own
// quarantine dirs, it is on the Git host for native, WSL and SSH alike, and
// `git prune` removes stale `tmp_*` entries if a crash ever strands one.
export const GIT_OBJECT_QUARANTINE_DIR_PREFIX = 'tmp_objdir-orca-merge-tree-'

// Decided by path syntax, not by platform: a Windows main process drives WSL Git.
function pathApiFor(value: string): typeof posix {
  return isWindowsAbsolutePathLike(value) ? win32 : posix
}

// Why: Git splits this variable on `:` (`;` on Windows) and C-unquotes a leading `"`.
function alternateObjectDirectoriesValue(gitPath: string): string {
  if (isWindowsAbsolutePathLike(gitPath) || !/[:"\\]/.test(gitPath)) {
    return gitPath
  }
  return `"${gitPath.replace(/[\\"]/g, (char) => `\\${char}`)}"`
}

/** Resolves the objects dir once per quarantine; each run gets its own scratch dir. */
export function createGitObjectQuarantine(host: GitObjectQuarantineHost): GitObjectQuarantine {
  let objectsDirectory: Promise<GitObjectsDirectory | undefined> | undefined
  const resolveObjectsDirectory = (): Promise<GitObjectsDirectory | undefined> => {
    objectsDirectory ??= host.resolveObjectsDirectory().catch(() => undefined)
    return objectsDirectory
  }

  return {
    async run(command) {
      const objects = await resolveObjectsDirectory()
      let scratchHostPath: string | undefined
      if (objects) {
        try {
          scratchHostPath = await host.makeTempDirectory(
            pathApiFor(objects.hostPath).join(objects.hostPath, GIT_OBJECT_QUARANTINE_DIR_PREFIX)
          )
        } catch {
          // Why: bookkeeping must not block the user's action; run unquarantined.
          scratchHostPath = undefined
        }
      }
      if (!objects || !scratchHostPath) {
        return command(undefined)
      }
      try {
        return await command({
          GIT_OBJECT_DIRECTORY: pathApiFor(objects.gitPath).join(
            objects.gitPath,
            pathApiFor(scratchHostPath).basename(scratchHostPath)
          ),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirectoriesValue(objects.gitPath)
        })
      } finally {
        await host.removeDirectory(scratchHostPath).catch(() => {})
      }
    }
  }
}
