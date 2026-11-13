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

it('reuses checkout capacity after cancellation and idempotent release across WSL routes', async () => {
  const scheduler = new GitAdmissionScheduler({ checkoutCap: 4, checkoutHeadroom: 0 })
  const held = await Promise.all([
    scheduler.acquire({ ...checkout, wslDistro: 'Ubuntu' }),
    scheduler.acquire({ ...checkout, cwd: '\\\\wsl.localhost\\Ubuntu\\repo' })
  ])
  const cancel = new AbortController()
  const waiting = scheduler.acquire({ ...checkout, wslDistro: 'ubuntu', signal: cancel.signal })
  const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  const otherRoute = await scheduler.acquire({ ...checkout, wslDistro: 'Debian' })
  cancel.abort()
  await rejected
  const replacement = scheduler.acquire({ ...checkout, wslDistro: 'UBUNTU' })
  held[0].release()
  held[0].release()
  const granted = await replacement
  granted.release()
  held[1].release()
  otherRoute.release()
  const next = await scheduler.acquire({ ...checkout, wslDistro: 'Ubuntu' })
  next.release()
})
