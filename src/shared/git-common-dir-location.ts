import * as path from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import { parseGitdirMarkerPayload } from './gitdir-marker-payload'
import {
  foldWslUncPathCaseInsensitiveParts,
  isWslUncPath,
  toWindowsWslDrivePath
} from './wsl-paths'

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path'
])

export type GitSubcommandLocation = {
  /** Effective cwd after any `-C` global options. */
  readonly cwd: string
  readonly gitDir?: string
  /** Index of the subcommand in `args`, or -1 when there is none. */
  readonly subcommandIndex: number
}

/** Skips git's global options to find the subcommand and the repository it addresses. */
export function locateGitSubcommand(
  args: readonly string[],
  initialCwd: string
): GitSubcommandLocation {
  let cwd = initialCwd
  let gitDir: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-C' && args[index + 1]) {
      cwd = path.resolve(cwd, args[index + 1])
      index += 1
      continue
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      cwd = path.resolve(cwd, arg.slice(2))
      continue
    }
    if (arg === '--git-dir' && args[index + 1]) {
      gitDir = path.resolve(cwd, args[index + 1])
      index += 1
      continue
    }
    if (arg.startsWith('--git-dir=')) {
      gitDir = path.resolve(cwd, arg.slice('--git-dir='.length))
      continue
    }
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('-')) {
      continue
    }
    return { cwd, gitDir, subcommandIndex: index }
  }
  return { cwd, gitDir, subcommandIndex: -1 }
}

/**
 * `node:path` itself, spelled so a test can drive the Win32 rules on a POSIX runner. Node picks the
 * same submodule for the default export, so this is the host's own behaviour, not an emulation.
 */
function hostPath(): typeof path.posix {
  return process.platform === 'win32' ? path.win32 : path.posix
}

/**
 * Where a Git metadata pointer (a `.git` gitfile payload or a `commondir`) lands in the reading
 * host's namespace.
 *
 * Why: git running inside WSL writes these in the guest namespace, and under a drive-spelled base
 * `path.resolve` reads `/mnt/c/repo/.git` as the non-existent `C:\mnt\c\repo\.git`, so the commondir
 * walk dead-ends and every linked worktree of one repo gets its own lock lane.
 *
 * Why the UNC base is excluded rather than handed to `resolveGitMetadataPath`: win32 `path.resolve`
 * already carries a WSL UNC base's distro onto a guest-rooted pointer, and a main worktree's `.git`
 * is a directory with no pointer to translate, so its key stays on that UNC spelling. Rewriting only
 * the linked worktrees to `C:\...` would split one repo across two lanes.
 */
function resolveMetadataPointer(basePath: string, rawPointer: string): string {
  if (process.platform === 'win32' && !isWslUncPath(basePath)) {
    const drivePath = toWindowsWslDrivePath(rawPointer)
    if (drivePath) {
      return drivePath
    }
  }
  return hostPath().resolve(basePath, rawPointer)
}

/**
 * Windows aliases `\\wsl$` to `\\wsl.localhost` and folds the distro name and any drvfs tail
 * case-insensitively, so two spellings of one WSL repo must not open two lock lanes.
 */
function canonicalizeGitCommonDirKey(key: string): string {
  if (process.platform !== 'win32') {
    return key
  }
  return foldWslUncPathCaseInsensitiveParts(key) ?? key
}

/** `realpath` takes no signal, so a hung 9P/UNC lookup outlives the cancelled fetch without this. */
async function realpathOrResolve(target: string, signal: AbortSignal | undefined): Promise<string> {
  try {
    return await waitForPromiseWithSignal(realpath(target), signal)
  } catch {
    // Why the synthetic error rather than the signal's reason: callers classify on `name`.
    if (signal?.aborted) {
      throw abortError()
    }
    return hostPath().resolve(target)
  }
}

export type GitCommonDirLocation = {
  /** Realpath'd common dir; pass through `gitCommonDirLockKey` before keying a lock on it. */
  readonly commonDir: string
  /** False when no `.git` was found and the value is only the fallback spelling. */
  readonly discovered: boolean
}

/** Walks `.git` markers and `commondir` without spawning git, so it is cheap enough per command. */
export async function resolveCanonicalGitCommonDir(
  worktreePath: string,
  signal: AbortSignal | undefined,
  explicitGitDir?: string
): Promise<GitCommonDirLocation> {
  let current = await realpathOrResolve(worktreePath, signal)
  let gitDir = explicitGitDir
  let discovered = explicitGitDir !== undefined
  while (!gitDir) {
    const dotGitPath = hostPath().join(current, '.git')
    try {
      const metadata = await waitForPromiseWithSignal(stat(dotGitPath), signal)
      if (metadata.isDirectory()) {
        gitDir = dotGitPath
        discovered = true
        break
      }
      const contents = await readFile(dotGitPath, { encoding: 'utf-8', signal })
      const marker = parseGitdirMarkerPayload(contents)
      if (marker) {
        gitDir = resolveMetadataPointer(current, marker)
        discovered = true
        break
      }
    } catch {
      if (signal?.aborted) {
        throw abortError()
      }
    }
    const parent = hostPath().dirname(current)
    if (parent === current) {
      gitDir = hostPath().join(current, '.git')
      break
    }
    current = parent
  }
  let commonGitDir = gitDir
  try {
    const contents = await readFile(hostPath().join(gitDir, 'commondir'), {
      encoding: 'utf-8',
      signal
    })
    if (contents.trim()) {
      commonGitDir = resolveMetadataPointer(gitDir, contents.trim())
    }
  } catch {
    if (signal?.aborted) {
      throw abortError()
    }
  }
  const canonicalGitDir = await realpathOrResolve(commonGitDir, signal)
  return { commonDir: canonicalGitDir, discovered }
}

/** A lock key for one piece of shared metadata under the common dir, e.g. `FETCH_HEAD`. */
export function gitCommonDirLockKey(commonDir: string, leaf: string): string {
  return canonicalizeGitCommonDirKey(hostPath().join(commonDir, leaf))
}
