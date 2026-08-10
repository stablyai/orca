import { randomUUID } from 'node:crypto'
import { access, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireGitWorktreeHostLock,
  gitWorktreeHostLockPathForTests,
  type GitWorktreeHostLockTestHooks
} from './git-worktree-host-lock'
import { createGitWorktreeDeadline } from './git-worktree-create-timeout'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((value) => rm(value, { recursive: true, force: true }))
  )
})

function repositoryIdentity(): string {
  return `/test/repository/${randomUUID()}`
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not receive a port')
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

async function createCrashedClaim(repository: string, pid = process.pid): Promise<string> {
  const lockPath = gitWorktreeHostLockPathForTests(repository)
  const token = randomUUID()
  const claimPath = join(lockPath, `${token}.claim`)
  cleanupPaths.push(lockPath)
  await mkdir(claimPath, { recursive: true, mode: 0o700 })
  await writeFile(
    join(claimPath, 'owner.json'),
    JSON.stringify({
      pid,
      port: await closedPort(),
      processToken: randomUUID(),
      token,
      choosing: false,
      ticket: 1
    })
  )
  return claimPath
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value)
    return true
  } catch {
    return false
  }
}

async function runContenders(
  repository: string,
  count: number,
  firstHooks: GitWorktreeHostLockTestHooks = {},
  activity = { active: 0, maxActive: 0 }
): Promise<{ acquired: number; released: number }> {
  let acquired = 0
  let released = 0
  const attempts = Array.from({ length: count }, async (_, index) => {
    const release = await acquireGitWorktreeHostLock(
      repository,
      createGitWorktreeDeadline(10_000),
      index === 0 ? firstHooks : undefined
    )
    acquired += 1
    activity.active += 1
    activity.maxActive = Math.max(activity.maxActive, activity.active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    activity.active -= 1
    await release()
    released += 1
  })
  const results = await Promise.allSettled(attempts)
  expect(results.filter((result) => result.status === 'rejected')).toEqual([])
  return { acquired, released }
}

describe('Git worktree host lock', () => {
  it('recovers a crashed process incarnation even when its pid is occupied', async () => {
    const repository = repositoryIdentity()
    const crashedClaim = await createCrashedClaim(repository)

    const release = await acquireGitWorktreeHostLock(repository, createGitWorktreeDeadline(1_000))

    expect(await pathExists(crashedClaim)).toBe(false)
    await release()
  })

  it('keeps a 64-contender successor private until owner publication', async () => {
    const repository = repositoryIdentity()
    const crashedClaim = await createCrashedClaim(repository)
    const pending = deferred()
    const publish = deferred()
    const hooks = {
      afterPendingClaimCreated: async () => {
        pending.resolve()
        await publish.promise
      }
    }
    const activity = { active: 0, maxActive: 0 }
    const successor = runContenders(repository, 1, hooks, activity)
    await pending.promise
    const contenders = runContenders(repository, 64, {}, activity)
    await vi.waitFor(() => expect(pathExists(crashedClaim)).resolves.toBe(false))
    publish.resolve()

    const [successorCounts, contenderCounts] = await Promise.all([successor, contenders])
    expect(successorCounts.acquired + contenderCounts.acquired).toBe(65)
    expect(successorCounts.released + contenderCounts.released).toBe(65)
    expect(activity.maxActive).toBe(1)
  })

  it('preserves a published live successor across 96 recovering contenders', async () => {
    const repository = repositoryIdentity()
    await createCrashedClaim(repository)
    const published = deferred()
    const finalize = deferred()
    const hooks = {
      afterClaimPublished: async () => {
        published.resolve()
        await finalize.promise
      }
    }
    const activity = { active: 0, maxActive: 0 }
    const successor = runContenders(repository, 1, hooks, activity)
    await published.promise
    const lockPath = gitWorktreeHostLockPathForTests(repository)
    const successorClaim = (await readdir(lockPath)).find((entry) => entry.endsWith('.claim'))
    const contenders = runContenders(repository, 96, {}, activity)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(successorClaim).toBeDefined()
    expect(await pathExists(join(lockPath, successorClaim as string))).toBe(true)
    finalize.resolve()
    const [successorCounts, contenderCounts] = await Promise.all([successor, contenders])
    expect(successorCounts.acquired + contenderCounts.acquired).toBe(97)
    expect(successorCounts.released + contenderCounts.released).toBe(97)
    expect(activity.maxActive).toBe(1)
  })

  it('cleans aborted and timed-out claims without displacing the owner', async () => {
    const repository = repositoryIdentity()
    cleanupPaths.push(gitWorktreeHostLockPathForTests(repository))
    const release = await acquireGitWorktreeHostLock(repository, createGitWorktreeDeadline(1_000))
    const controller = new AbortController()
    const aborted = acquireGitWorktreeHostLock(
      repository,
      createGitWorktreeDeadline(1_000, controller.signal)
    )
    const timedOut = acquireGitWorktreeHostLock(repository, createGitWorktreeDeadline(25))
    controller.abort()

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await expect(timedOut).rejects.toThrow('timed out during host lock queue')
    await release()
    const nextRelease = await acquireGitWorktreeHostLock(
      repository,
      createGitWorktreeDeadline(1_000)
    )
    await nextRelease()
    expect(
      (await readdir(gitWorktreeHostLockPathForTests(repository))).filter((entry) =>
        entry.endsWith('.claim')
      )
    ).toHaveLength(0)
  })

  it.runIf(process.platform !== 'win32')(
    'rejects a symlink lock without touching its target',
    async () => {
      const repository = repositoryIdentity()
      const lockPath = gitWorktreeHostLockPathForTests(repository)
      const targetPath = `${lockPath}.target`
      cleanupPaths.push(lockPath, targetPath)
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
      await mkdir(targetPath)
      await writeFile(join(targetPath, 'sentinel'), 'preserve')
      await symlink(targetPath, lockPath, 'dir')

      await expect(
        acquireGitWorktreeHostLock(repository, createGitWorktreeDeadline(1_000))
      ).rejects.toThrow('Unsafe Git worktree host lock directory')
      expect(await pathExists(join(targetPath, 'sentinel'))).toBe(true)
    }
  )
})
