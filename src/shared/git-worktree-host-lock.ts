import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  getGitWorktreeHostProcessIdentity,
  probeGitWorktreeHostProcess,
  type GitWorktreeHostProcessIdentity
} from './git-worktree-host-process-identity'
import {
  remainingGitWorktreeCreateMs,
  runWithinGitWorktreeDeadline,
  type GitWorktreeCreateDeadline
} from './git-worktree-create-timeout'
import type { GitWorktreeHostLockTestHooks } from './git-worktree-host-lock-types'

type HostLockOwner = GitWorktreeHostProcessIdentity & {
  token: string
  choosing: boolean
  ticket?: number
}

export type { GitWorktreeHostLockTestHooks } from './git-worktree-host-lock-types'

const HOST_LOCK_INITIALIZATION_GRACE_MS = 5_000
const HOST_LOCK_POLL_MS = 25
const CLAIM_SUFFIX = '.claim'
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/
const localClaimOwners = new Map<string, HostLockOwner>()

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

async function validatePrivateDirectory(directory: string, description: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe Git worktree ${description}: "${directory}"`)
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`Git worktree ${description} is owned by another user: "${directory}"`)
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error(`Git worktree ${description} is accessible by another user: "${directory}"`)
  }
}

async function ensureHostLockDirectory(
  repository: string,
  deadline: GitWorktreeCreateDeadline
): Promise<string> {
  const root = hostLockRoot()
  await runWithinGitWorktreeDeadline(deadline, 'host lock root creation', () =>
    mkdir(root, { recursive: true, mode: 0o700 })
  )
  await runWithinGitWorktreeDeadline(deadline, 'host lock root validation', () =>
    validatePrivateDirectory(root, 'host lock root')
  )
  const lockPath = gitWorktreeHostLockPathForTests(repository)
  await runWithinGitWorktreeDeadline(deadline, 'host lock directory creation', () =>
    mkdir(lockPath, { recursive: true, mode: 0o700 })
  )
  await runWithinGitWorktreeDeadline(deadline, 'host lock directory validation', () =>
    validatePrivateDirectory(lockPath, 'host lock directory')
  )
  return lockPath
}

function parseOwner(value: string): HostLockOwner | null {
  try {
    const owner = JSON.parse(value) as Partial<HostLockOwner>
    if (
      !Number.isSafeInteger(owner.pid) ||
      !Number.isSafeInteger(owner.port) ||
      typeof owner.processToken !== 'string' ||
      typeof owner.token !== 'string' ||
      !TOKEN_PATTERN.test(owner.token) ||
      typeof owner.choosing !== 'boolean' ||
      (!owner.choosing && !Number.isSafeInteger(owner.ticket))
    ) {
      return null
    }
    return owner as HostLockOwner
  } catch {
    return null
  }
}

async function readClaimOwner(claimPath: string): Promise<HostLockOwner | null> {
  const localOwner = localClaimOwners.get(claimPath)
  if (localOwner) {
    return localOwner
  }
  try {
    return parseOwner(await readFile(path.join(claimPath, 'owner.json'), 'utf8'))
  } catch {
    return null
  }
}

async function claimCanBeRemoved(
  claimPath: string,
  owner: HostLockOwner | null,
  deadline: GitWorktreeCreateDeadline
): Promise<boolean> {
  if (owner) {
    const probeTimeoutMs = remainingGitWorktreeCreateMs(deadline, 'host lock owner probe')
    return (
      (await runWithinGitWorktreeDeadline(deadline, 'host lock owner probe', () =>
        probeGitWorktreeHostProcess(owner, probeTimeoutMs)
      )) === 'dead'
    )
  }
  try {
    return Date.now() - (await stat(claimPath)).mtimeMs >= HOST_LOCK_INITIALIZATION_GRACE_MS
  } catch (error) {
    return getErrorCode(error) === 'ENOENT'
  }
}

async function retireClaim(
  claimPath: string,
  hooks: GitWorktreeHostLockTestHooks = {}
): Promise<void> {
  await hooks.beforeClaimRetired?.(claimPath)
  const retiredPath = `${claimPath}.retired-${randomUUID()}`
  try {
    await rename(claimPath, retiredPath)
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      localClaimOwners.delete(claimPath)
      return
    }
    throw error
  }
  localClaimOwners.delete(claimPath)
  await rm(retiredPath, { recursive: true, force: true }).catch(() => undefined)
}

async function listLiveClaims(
  lockPath: string,
  deadline: GitWorktreeCreateDeadline,
  hooks: GitWorktreeHostLockTestHooks = {}
): Promise<HostLockOwner[]> {
  const entries = await readdir(lockPath, { withFileTypes: true })
  const owners: HostLockOwner[] = []
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.name.endsWith(CLAIM_SUFFIX)) {
        return
      }
      const claimPath = path.join(lockPath, entry.name)
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Unsafe Git worktree host lock claim: "${claimPath}"`)
      }
      const owner = await readClaimOwner(claimPath)
      if (owner && entry.name !== `${owner.token}${CLAIM_SUFFIX}`) {
        throw new Error(`Git worktree host lock claim identity does not match: "${claimPath}"`)
      }
      if (await claimCanBeRemoved(claimPath, owner, deadline)) {
        await hooks.beforeStaleClaimRemoved?.(claimPath)
        await retireClaim(claimPath, hooks)
        return
      }
      if (!owner) {
        throw new Error(`Git worktree host lock claim is not initialized: "${claimPath}"`)
      }
      owners.push(owner)
    })
  )
  return owners
}

async function publishClaim(
  lockPath: string,
  owner: HostLockOwner,
  hooks: GitWorktreeHostLockTestHooks
): Promise<string> {
  const pendingPath = path.join(lockPath, `${owner.token}.pending`)
  const claimPath = path.join(lockPath, `${owner.token}${CLAIM_SUFFIX}`)
  await mkdir(pendingPath, { mode: 0o700 })
  try {
    await hooks.afterPendingClaimCreated?.()
    await writeFile(path.join(pendingPath, 'owner.json'), JSON.stringify(owner), {
      flag: 'wx',
      mode: 0o600
    })
    await rename(pendingPath, claimPath)
    localClaimOwners.set(claimPath, owner)
    await hooks.afterClaimPublished?.({ path: claimPath, owner })
    return claimPath
  } catch (error) {
    await rm(pendingPath, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function finalizeClaim(
  claimPath: string,
  owner: HostLockOwner,
  deadline: GitWorktreeCreateDeadline,
  hooks: GitWorktreeHostLockTestHooks
): Promise<HostLockOwner> {
  const claims = await listLiveClaims(path.dirname(claimPath), deadline, hooks)
  const ticket = claims.reduce((max, claim) => Math.max(max, claim.ticket ?? 0), 0) + 1
  const finalized = { ...owner, choosing: false, ticket }
  const pendingOwnerPath = path.join(claimPath, `owner-${owner.token}.pending`)
  await writeFile(pendingOwnerPath, JSON.stringify(finalized), { flag: 'wx', mode: 0o600 })
  await rename(pendingOwnerPath, path.join(claimPath, 'owner.json'))
  localClaimOwners.set(claimPath, finalized)
  return finalized
}

function claimPrecedes(candidate: HostLockOwner, owner: HostLockOwner): boolean {
  if (candidate.choosing || candidate.ticket === undefined || owner.ticket === undefined) {
    return true
  }
  return (
    candidate.ticket < owner.ticket ||
    (candidate.ticket === owner.ticket && candidate.token < owner.token)
  )
}

function precedingClaim(owner: HostLockOwner, claims: HostLockOwner[]): HostLockOwner | undefined {
  return claims
    .filter((claim) => claim.token !== owner.token && claimPrecedes(claim, owner))
    .sort((left, right) => {
      const ticketDifference = (right.ticket ?? 0) - (left.ticket ?? 0)
      return ticketDifference || right.token.localeCompare(left.token)
    })[0]
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

async function waitForClaimTurn(
  lockPath: string,
  owner: HostLockOwner,
  deadline: GitWorktreeCreateDeadline,
  hooks: GitWorktreeHostLockTestHooks
): Promise<void> {
  while (true) {
    const claims = await listLiveClaims(lockPath, deadline, hooks)
    if (claims.some((claim) => claim.token !== owner.token && claim.choosing)) {
      await waitForHostLockRetry(deadline)
      continue
    }
    const predecessor = precedingClaim(owner, claims)
    if (!predecessor) {
      return
    }
    const predecessorPath = path.join(lockPath, `${predecessor.token}${CLAIM_SUFFIX}`)
    while (true) {
      const current = await readClaimOwner(predecessorPath)
      if (!current) {
        break
      }
      if (await claimCanBeRemoved(predecessorPath, current, deadline)) {
        await hooks.beforeStaleClaimRemoved?.(predecessorPath)
        await retireClaim(predecessorPath, hooks)
        break
      }
      await waitForHostLockRetry(deadline)
    }
  }
}

export async function acquireGitWorktreeHostLock(
  repository: string,
  deadline: GitWorktreeCreateDeadline,
  hooks: GitWorktreeHostLockTestHooks = {}
): Promise<() => Promise<void>> {
  const lockPath = await ensureHostLockDirectory(repository, deadline)
  const token = randomUUID()
  const identity = await getGitWorktreeHostProcessIdentity()
  const claimPath = await publishClaim(lockPath, { ...identity, token, choosing: true }, hooks)
  try {
    const owner = await finalizeClaim(
      claimPath,
      { ...identity, token, choosing: true },
      deadline,
      hooks
    )
    await waitForClaimTurn(lockPath, owner, deadline, hooks)
    let released = false
    return async () => {
      if (released) {
        return
      }
      await retireClaim(claimPath, hooks)
      released = true
    }
  } catch (error) {
    await retireClaim(claimPath, hooks).catch(() => undefined)
    throw error
  }
}
