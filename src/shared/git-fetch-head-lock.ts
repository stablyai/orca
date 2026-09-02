import * as path from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import { parseGitdirMarkerPayload } from './gitdir-marker-payload'
import { runWithGitOperationLock } from './git-operation-lock'
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

type GitFetchHeadCommand = { needsLock: boolean; cwd: string; gitDir?: string }

export function resolveGitFetchHeadCommand(
  args: readonly string[],
  initialCwd: string
): GitFetchHeadCommand {
  let cwd = initialCwd
  let gitDir: string | undefined
  let subcommandIndex = -1
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
    subcommandIndex = index
    break
  }
  const subcommand = args[subcommandIndex]
  if (subcommand === 'pull') {
    return { needsLock: true, cwd, gitDir }
  }
  if (subcommand !== 'fetch') {
    return { needsLock: false, cwd, gitDir }
  }
  let writesFetchHead = true
  let updatesRemoteTrackingRef = false
  for (const arg of args.slice(subcommandIndex + 1)) {
    if (arg === '--no-write-fetch-head') {
      writesFetchHead = false
    } else if (arg === '--write-fetch-head') {
      writesFetchHead = true
    } else if (arg.includes(':refs/remotes/')) {
      updatesRemoteTrackingRef = true
    }
  }
  // Why: explicit tracking-ref updates race sibling-worktree fetch transactions even without FETCH_HEAD.
  return { needsLock: writesFetchHead || updatesRemoteTrackingRef, cwd, gitDir }
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
 * walk dead-ends and every linked worktree of one repo gets its own fetch lane.
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
 * case-insensitively, so two spellings of one WSL repo must not open two fetch lanes.
 */
function canonicalizeFetchHeadLockKey(key: string): string {
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

async function fetchLockPath(
  worktreePath: string,
  signal: AbortSignal | undefined,
  explicitGitDir?: string
): Promise<string> {
  let current = await realpathOrResolve(worktreePath, signal)
  let gitDir = explicitGitDir
  while (!gitDir) {
    const dotGitPath = hostPath().join(current, '.git')
    try {
      const metadata = await waitForPromiseWithSignal(stat(dotGitPath), signal)
      if (metadata.isDirectory()) {
        gitDir = dotGitPath
        break
      }
      const contents = await readFile(dotGitPath, { encoding: 'utf-8', signal })
      const marker = parseGitdirMarkerPayload(contents)
      if (marker) {
        gitDir = resolveMetadataPointer(current, marker)
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
  return canonicalizeFetchHeadLockKey(hostPath().join(canonicalGitDir, 'FETCH_HEAD'))
}

export async function runWithGitFetchHeadLock<T>(
  worktreePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  explicitGitDir?: string
): Promise<T> {
  const key = await fetchLockPath(worktreePath, signal, explicitGitDir)
  return runWithGitOperationLock(key, signal, run)
}
