import { realpath } from 'node:fs/promises'
import * as path from 'node:path'
import { acquireGitWorktreeHostLock } from './git-worktree-host-lock'
import {
  remainingGitWorktreeCreateMs,
  runWithinGitWorktreeDeadline,
  type GitWorktreeCreateDeadline
} from './git-worktree-create-timeout'

export type GitWorktreeCreateLockIdentity = Readonly<{
  repository: string
  target: string
}>

type LockWaiter = {
  grant: () => void
  cancel: (error: Error) => void
}

type CreateLockState = {
  waiters: Set<LockWaiter>
}

type GitWorktreeCreateLockExec = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>

type ResolveGitOutputPath = (cwd: string, outputPath: string) => string

const createLocks = new Map<string, CreateLockState>()

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function pathApi(value: string): typeof path.posix | typeof path.win32 {
  return process.platform === 'win32' || looksLikeWindowsPath(value) ? path.win32 : path.posix
}

function normalizePath(value: string): string {
  const api = pathApi(value)
  const normalized = api.normalize(api.resolve(value))
  return api === path.win32 ? normalized.toLowerCase() : normalized
}

async function canonicalizePath(
  value: string,
  deadline: GitWorktreeCreateDeadline
): Promise<string> {
  const api = pathApi(value)
  const resolved = api.resolve(value)
  try {
    return normalizePath(
      await runWithinGitWorktreeDeadline(deadline, `filesystem realpath of "${resolved}"`, () =>
        realpath(resolved)
      )
    )
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT' && getErrorCode(error) !== 'ENOTDIR') {
      throw error
    }
    const parent = api.dirname(resolved)
    if (parent === resolved) {
      return normalizePath(resolved)
    }
    return normalizePath(api.join(await canonicalizePath(parent, deadline), api.basename(resolved)))
  }
}

export async function resolveGitWorktreeCreateLockIdentity(
  git: GitWorktreeCreateLockExec,
  repoPath: string,
  targetDir: string,
  deadline: GitWorktreeCreateDeadline,
  resolveGitPath: ResolveGitOutputPath = (cwd, output) => path.resolve(cwd, output.trim())
): Promise<GitWorktreeCreateLockIdentity> {
  const { stdout } = await git(['rev-parse', '--git-common-dir'], repoPath)
  const commonDir = resolveGitPath(repoPath, stdout)
  const targetPath = pathApi(repoPath).resolve(repoPath, targetDir)
  const [repository, target] = await Promise.all([
    canonicalizePath(commonDir, deadline),
    canonicalizePath(targetPath, deadline)
  ])
  return { repository, target }
}

function releaseCreateLock(key: string, state: CreateLockState): void {
  const next = state.waiters.values().next().value as LockWaiter | undefined
  if (next) {
    state.waiters.delete(next)
    next.grant()
    return
  }
  if (createLocks.get(key) === state) {
    createLocks.delete(key)
  }
}

async function acquireCreateLock(
  key: string,
  deadline: GitWorktreeCreateDeadline
): Promise<() => void> {
  let state = createLocks.get(key)
  if (!state) {
    const acquiredState: CreateLockState = { waiters: new Set() }
    createLocks.set(key, acquiredState)
    return () => releaseCreateLock(key, acquiredState)
  }

  const timeoutMs = remainingGitWorktreeCreateMs(deadline, 'worktree create lock queue')
  return new Promise<() => void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const cleanup = (): void => {
      clearTimeout(timer)
      deadline.signal?.removeEventListener('abort', onAbort)
    }
    const rejectWait = (error: Error): void => {
      if (!state.waiters.delete(waiter)) {
        return
      }
      cleanup()
      reject(error)
    }
    const onAbort = (): void => {
      const error = new Error('Git worktree creation was cancelled during lock queue.')
      error.name = 'AbortError'
      rejectWait(error)
    }
    const waiter: LockWaiter = {
      grant: () => {
        cleanup()
        resolve(() => releaseCreateLock(key, state))
      },
      cancel: rejectWait
    }
    timer = setTimeout(
      () => waiter.cancel(new Error('Git worktree creation timed out during lock queue.')),
      timeoutMs
    )
    deadline.signal?.addEventListener('abort', onAbort, { once: true })
    state.waiters.add(waiter)
    if (deadline.signal?.aborted) {
      onAbort()
    }
  })
}

export async function withGitWorktreeCreateLock<T>(
  identity: GitWorktreeCreateLockIdentity,
  deadline: GitWorktreeCreateDeadline,
  operation: (lockedIdentity: GitWorktreeCreateLockIdentity) => Promise<T>
): Promise<T> {
  const releaseProcessLock = await acquireCreateLock(identity.repository, deadline)
  let releaseHostLock: (() => Promise<void>) | undefined
  try {
    releaseHostLock = await acquireGitWorktreeHostLock(identity.repository, deadline)
    const lockedIdentity = {
      repository: identity.repository,
      target: await canonicalizePath(identity.target, deadline)
    }
    return await operation(lockedIdentity)
  } finally {
    try {
      await releaseHostLock?.()
    } finally {
      releaseProcessLock()
    }
  }
}

export function resetGitWorktreeCreateLocksForTests(): void {
  createLocks.clear()
}
