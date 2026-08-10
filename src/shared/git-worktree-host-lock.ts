import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  remainingGitWorktreeCreateMs,
  runWithinGitWorktreeDeadline,
  type GitWorktreeCreateDeadline
} from './git-worktree-create-timeout'

type HostLockOwner = {
  pid: number
  token: string
}

const HOST_LOCK_INITIALIZATION_GRACE_MS = 5_000
const HOST_LOCK_POLL_MS = 25

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function hostLockRoot(): string {
  const user = typeof process.getuid === 'function' ? process.getuid() : 'windows'
  const testPool = process.env.VITEST_POOL_ID ? `-${process.env.VITEST_POOL_ID}` : ''
  return path.join(tmpdir(), `orca-${user}${testPool}-git-worktree-create-locks`)
}

async function ensureHostLockRoot(deadline: GitWorktreeCreateDeadline): Promise<string> {
  const root = hostLockRoot()
  await runWithinGitWorktreeDeadline(deadline, 'host lock root creation', () =>
    mkdir(root, { recursive: true, mode: 0o700 })
  )
  const info = await runWithinGitWorktreeDeadline(deadline, 'host lock root validation', () =>
    lstat(root)
  )
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe Git worktree host lock root: "${root}"`)
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`Git worktree host lock root is owned by another user: "${root}"`)
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error(`Git worktree host lock root is accessible by another user: "${root}"`)
  }
  return root
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return getErrorCode(error) !== 'ESRCH'
  }
}

async function readHostLockOwner(lockPath: string): Promise<HostLockOwner | null> {
  try {
    const value = await readFile(path.join(lockPath, 'owner.json'), 'utf8')
    const parsed = JSON.parse(value) as Partial<HostLockOwner>
    return Number.isSafeInteger(parsed.pid) && typeof parsed.token === 'string'
      ? { pid: parsed.pid as number, token: parsed.token }
      : null
  } catch {
    return null
  }
}

async function recoverDeadHostLock(lockPath: string, token: string): Promise<boolean> {
  try {
    const info = await lstat(lockPath)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Unsafe Git worktree host lock path: "${lockPath}"`)
    }
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return true
    }
    throw error
  }
  const owner = await readHostLockOwner(lockPath)
  if (owner && processIsAlive(owner.pid)) {
    return false
  }
  if (!owner) {
    try {
      const info = await stat(lockPath)
      if (Date.now() - info.mtimeMs < HOST_LOCK_INITIALIZATION_GRACE_MS) {
        return false
      }
    } catch (error) {
      return getErrorCode(error) === 'ENOENT'
    }
  }
  const stalePath = `${lockPath}.stale-${token}`
  try {
    await rename(lockPath, stalePath)
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return true
    }
    return false
  }
  await rm(stalePath, { recursive: true, force: true }).catch(() => undefined)
  return true
}

export function gitWorktreeHostLockPathForTests(repository: string): string {
  const key = createHash('sha256').update(repository).digest('hex')
  return path.join(hostLockRoot(), `${key}.lock`)
}

async function waitForHostLockRetry(deadline: GitWorktreeCreateDeadline): Promise<void> {
  const waitMs = Math.min(
    HOST_LOCK_POLL_MS,
    remainingGitWorktreeCreateMs(deadline, 'host lock queue')
  )
  await runWithinGitWorktreeDeadline(
    deadline,
    'host lock queue',
    () => new Promise((resolve) => setTimeout(resolve, waitMs))
  )
}

export async function acquireGitWorktreeHostLock(
  repository: string,
  deadline: GitWorktreeCreateDeadline
): Promise<() => Promise<void>> {
  await ensureHostLockRoot(deadline)
  const lockPath = gitWorktreeHostLockPathForTests(repository)
  const token = randomUUID()
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      try {
        await writeFile(
          path.join(lockPath, 'owner.json'),
          JSON.stringify({ pid: process.pid, token }),
          { flag: 'wx', mode: 0o600 }
        )
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true })
        throw error
      }
      return async () => {
        const owner = await readHostLockOwner(lockPath)
        if (owner?.pid === process.pid && owner.token === token) {
          const releasedPath = `${lockPath}.released-${token}`
          await rename(lockPath, releasedPath)
          await rm(releasedPath, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    } catch (error) {
      if (getErrorCode(error) !== 'EEXIST') {
        throw error
      }
    }
    if (!(await recoverDeadHostLock(lockPath, token))) {
      await waitForHostLockRetry(deadline)
    }
  }
}
