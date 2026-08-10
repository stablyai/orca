import { spawn } from 'node:child_process'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireGitWorktreeHostLock,
  gitWorktreeHostLockPathForTests
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

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const pid = child.pid
  if (!pid) {
    throw new Error('Child process did not receive a pid')
  }
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => resolve())
  })
  return pid
}

describe('Git worktree host lock', () => {
  it('recovers an owner left by a crashed process', async () => {
    const repository = repositoryIdentity()
    const lockPath = gitWorktreeHostLockPathForTests(repository)
    cleanupPaths.push(lockPath)
    await mkdir(lockPath, { recursive: true, mode: 0o700 })
    await writeFile(
      `${lockPath}/owner.json`,
      JSON.stringify({ pid: await exitedPid(), token: 'crashed-owner' })
    )

    const release = await acquireGitWorktreeHostLock(repository, createGitWorktreeDeadline(1_000))
    await expect(release()).resolves.toBeUndefined()
  })

  it('bounds and cancels waiters without displacing a live owner', async () => {
    const repository = repositoryIdentity()
    const release = await acquireGitWorktreeHostLock(repository, createGitWorktreeDeadline(1_000))
    const controller = new AbortController()
    const waiting = acquireGitWorktreeHostLock(
      repository,
      createGitWorktreeDeadline(1_000, controller.signal)
    )
    controller.abort()

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await release()
    const nextRelease = await acquireGitWorktreeHostLock(
      repository,
      createGitWorktreeDeadline(1_000)
    )
    await nextRelease()
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
      await writeFile(`${targetPath}/sentinel`, 'preserve')
      await symlink(targetPath, lockPath, 'dir')

      await expect(
        acquireGitWorktreeHostLock(repository, createGitWorktreeDeadline(1_000))
      ).rejects.toThrow('Unsafe Git worktree host lock path')
    }
  )
})
