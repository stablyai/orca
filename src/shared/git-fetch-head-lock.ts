import * as path from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { runWithGitOperationLock } from './git-operation-lock'

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

async function fetchLockPath(
  worktreePath: string,
  signal: AbortSignal | undefined,
  explicitGitDir?: string
): Promise<string> {
  let current = await realpath(worktreePath).catch(() => path.resolve(worktreePath))
  let gitDir = explicitGitDir
  while (!gitDir) {
    const dotGitPath = path.join(current, '.git')
    try {
      const metadata = await stat(dotGitPath)
      if (metadata.isDirectory()) {
        gitDir = dotGitPath
        break
      }
      const contents = await readFile(dotGitPath, { encoding: 'utf-8', signal })
      const match = contents.match(/^gitdir:\s*(.+)\s*$/m)
      if (match) {
        gitDir = path.resolve(current, match[1])
        break
      }
    } catch {
      if (signal?.aborted) {
        throw abortError()
      }
    }
    const parent = path.dirname(current)
    if (parent === current) {
      gitDir = path.join(current, '.git')
      break
    }
    current = parent
  }
  let commonGitDir = gitDir
  try {
    const contents = await readFile(path.join(gitDir, 'commondir'), { encoding: 'utf-8', signal })
    if (contents.trim()) {
      commonGitDir = path.resolve(gitDir, contents.trim())
    }
  } catch {
    if (signal?.aborted) {
      throw abortError()
    }
  }
  const canonicalGitDir = await realpath(commonGitDir).catch(() => path.resolve(commonGitDir))
  return path.join(canonicalGitDir, 'FETCH_HEAD')
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
