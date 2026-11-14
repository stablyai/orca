import { expect, it } from 'vitest'
import { GitAdmissionScheduler } from './git-admission-scheduler'
import type { GitAdmissionRequest } from './git-admission-state'

it('keeps interactive work ahead of aged automatic work without losing background progress', async () => {
  let now = 0
  const scheduler = new GitAdmissionScheduler({
    generalCap: 1,
    generalHeadroom: 1,
    now: () => now
  })
  const holder = { args: ['status'], cwd: '/repo', tier: 'interactive' as const }
  const base = await scheduler.acquire(holder)
  const reserve = await scheduler.acquire(holder)
  const order: string[] = []
  const enqueue = (label: string, request: GitAdmissionRequest): Promise<void> =>
    scheduler.acquire(request).then((grant) => {
      order.push(label)
      grant.release()
    })
  const status = { args: ['status', '--porcelain'], cwd: '/repo', tier: 'status' as const }
  try {
    const background = enqueue('background', {
      args: ['worktree', 'list'],
      cwd: '/repo',
      tier: 'background'
    })
    now = 15_001
    const agedStatus = enqueue('aged status', status)
    now = 30_002
    const freshStatus = enqueue('fresh status', status)
    const interactive = enqueue('interactive', { ...status, tier: 'interactive' })
    base.release()
    await Promise.all([background, agedStatus, freshStatus, interactive])
    expect(order).toEqual(['interactive', 'background', 'aged status', 'fresh status'])
  } finally {
    base.release()
    reserve.release()
  }
})
