import { expect, it } from 'vitest'
import { GitAdmissionScheduler } from './git-admission-scheduler'

const checkout = {
  args: ['worktree', 'add', '/checkout'],
  cwd: '/repo',
  admissionClass: 'checkout' as const
}

it('reserves interactive create capacity and leaves reads and other mutations independent', async () => {
  const scheduler = new GitAdmissionScheduler()
  const preparations = await Promise.all([
    scheduler.acquire({ ...checkout, tier: 'status' }),
    scheduler.acquire({ ...checkout, tier: 'status' })
  ])
  const cancelPreparation = new AbortController()
  const queuedPreparation = scheduler.acquire({
    ...checkout,
    tier: 'status',
    signal: cancelPreparation.signal
  })
  const canceled = expect(queuedPreparation).rejects.toMatchObject({ name: 'AbortError' })
  const interactive = await scheduler.acquire({ ...checkout, tier: 'interactive' })
  const cancelCreate = new AbortController()
  const queuedCreate = scheduler.acquire({
    ...checkout,
    tier: 'interactive',
    signal: cancelCreate.signal
  })
  const canceledCreate = expect(queuedCreate).rejects.toMatchObject({ name: 'AbortError' })
  const unrelated = await Promise.all(
    [
      ['rev-parse', 'HEAD'],
      ['fetch', 'origin'],
      ['restore', 'file'],
      ['checkout', 'feature']
    ].map((args) => scheduler.acquire({ args, cwd: '/other', tier: 'interactive' }))
  )
  unrelated.forEach((grant) => grant.release())
  cancelPreparation.abort()
  cancelCreate.abort()
  await Promise.all([canceled, canceledCreate])
  preparations.forEach((grant) => grant.release())
  interactive.release()
})
