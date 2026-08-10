import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_WORKTREE_HOST_LOCK_RELEASE_RETRY_MS,
  resetGitWorktreeCreateLocksForTests,
  withGitWorktreeCreateLock
} from './git-worktree-create-lock'
import { gitWorktreeHostLockPathForTests } from './git-worktree-host-lock'
import { createGitWorktreeDeadline } from './git-worktree-create-timeout'

afterEach(() => resetGitWorktreeCreateLocksForTests())

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('git worktree host-lock release', () => {
  it('retires a transiently busy claim before admitting a same-process successor', async () => {
    const repository = `/repo/${randomUUID()}/.git`
    const identity = { repository, target: '/target' }
    let retirementAttempts = 0
    try {
      await expect(
        withGitWorktreeCreateLock(identity, createGitWorktreeDeadline(1_000), async () => {}, {
          beforeClaimRetired: async () => {
            retirementAttempts += 1
            if (retirementAttempts === 1) {
              throw Object.assign(new Error('injected busy claim'), { code: 'EBUSY' })
            }
          }
        })
      ).resolves.toBeUndefined()
      await expect(
        withGitWorktreeCreateLock(identity, createGitWorktreeDeadline(250), async () => {})
      ).resolves.toBeUndefined()
      expect(retirementAttempts).toBe(2)
    } finally {
      await rm(gitWorktreeHostLockPathForTests(repository), { recursive: true, force: true })
    }
  })

  it('bounds repeated EBUSY retries without retaining process exit or double-releasing', async () => {
    const repository = `/repo/${randomUUID()}/.git`
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    let retirementAttempts = 0
    try {
      await expect(
        withGitWorktreeCreateLock(
          { repository, target: '/target' },
          createGitWorktreeDeadline(1_000),
          async () => {},
          {
            beforeClaimRetired: async () => {
              retirementAttempts += 1
              if (retirementAttempts < 3) {
                throw Object.assign(new Error('injected busy claim'), { code: 'EBUSY' })
              }
            }
          }
        )
      ).resolves.toBeUndefined()
      const retryTimers = timerSpy.mock.calls.flatMap((call, index) =>
        call[1] === GIT_WORKTREE_HOST_LOCK_RELEASE_RETRY_MS
          ? [timerSpy.mock.results[index]?.value as NodeJS.Timeout]
          : []
      )
      expect(retirementAttempts).toBe(3)
      expect(retryTimers).toHaveLength(2)
      expect(retryTimers.every((timer) => !timer.hasRef())).toBe(true)
    } finally {
      timerSpy.mockRestore()
      await rm(gitWorktreeHostLockPathForTests(repository), { recursive: true, force: true })
    }
  })

  it('uses a fresh bounded retirement budget after the operation deadline expires', async () => {
    const repository = `/repo/${randomUUID()}/.git`
    let retirementAttempts = 0
    try {
      await expect(
        withGitWorktreeCreateLock(
          { repository, target: '/target' },
          createGitWorktreeDeadline(100),
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 125))
          },
          {
            beforeClaimRetired: async () => {
              retirementAttempts += 1
              if (retirementAttempts === 1) {
                throw Object.assign(new Error('injected busy claim'), { code: 'EBUSY' })
              }
            }
          }
        )
      ).resolves.toBeUndefined()
      expect(retirementAttempts).toBe(2)
    } finally {
      await rm(gitWorktreeHostLockPathForTests(repository), { recursive: true, force: true })
    }
  })

  it('does not retry a non-transient retirement failure', async () => {
    const repository = `/repo/${randomUUID()}/.git`
    const retirementError = Object.assign(new Error('claim access denied'), { code: 'EACCES' })
    let retirementAttempts = 0
    try {
      await expect(
        withGitWorktreeCreateLock(
          { repository, target: '/target' },
          createGitWorktreeDeadline(1_000),
          async () => {},
          {
            beforeClaimRetired: async () => {
              retirementAttempts += 1
              throw retirementError
            }
          }
        )
      ).rejects.toBe(retirementError)
      expect(retirementAttempts).toBe(1)
    } finally {
      await rm(gitWorktreeHostLockPathForTests(repository), { recursive: true, force: true })
    }
  })

  it('serializes wrapper contention through a transiently busy retirement', async () => {
    const repository = `/repo/${randomUUID()}/.git`
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const activity = { active: 0, maxActive: 0, acquired: 0, completed: 0 }
    let retirementAttempts = 0
    try {
      const attempts = Array.from({ length: 32 }, (_, index) =>
        withGitWorktreeCreateLock(
          { repository, target: `/target-${index}` },
          createGitWorktreeDeadline(5_000),
          async () => {
            activity.acquired += 1
            activity.active += 1
            activity.maxActive = Math.max(activity.maxActive, activity.active)
            if (index === 0) {
              firstStarted.resolve()
              await releaseFirst.promise
            }
            activity.active -= 1
            activity.completed += 1
          },
          {
            beforeClaimRetired: async () => {
              retirementAttempts += 1
              if (index === 0 && retirementAttempts === 1) {
                throw Object.assign(new Error('injected busy claim'), { code: 'EBUSY' })
              }
            }
          }
        )
      )
      await firstStarted.promise
      expect(activity).toMatchObject({ acquired: 1, active: 1, maxActive: 1 })
      releaseFirst.resolve()
      const results = await Promise.allSettled(attempts)

      expect(results.filter((result) => result.status === 'rejected')).toEqual([])
      expect(activity).toEqual({ active: 0, maxActive: 1, acquired: 32, completed: 32 })
      expect(retirementAttempts).toBe(33)
    } finally {
      await rm(gitWorktreeHostLockPathForTests(repository), { recursive: true, force: true })
    }
  })
})
