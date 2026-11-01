import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  GitAdmissionScheduler,
  type GitAdmissionGrant,
  type GitAdmissionRequest
} from './git-admission-scheduler'

type Pending = {
  controller: AbortController
  grant?: GitAdmissionGrant
  promise: Promise<GitAdmissionGrant>
}
const pendingAdmissions: Pending[] = []
const poll = (cwd = '/repo'): GitAdmissionRequest => ({ cwd, args: ['status', '--porcelain=v2'] })
const flushAdmission = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

function start(scheduler: GitAdmissionScheduler, request: GitAdmissionRequest) {
  const controller = new AbortController()
  const entry: Pending = {
    controller,
    promise: scheduler.acquire({ ...request, signal: controller.signal })
  }
  entry.promise = entry.promise.then((grant) => {
    entry.grant = grant
    return grant
  })
  void entry.promise.catch(() => {})
  pendingAdmissions.push(entry)
  return entry
}

afterEach(async () => {
  for (const entry of pendingAdmissions) {
    entry.controller.abort()
  }
  await Promise.allSettled(pendingAdmissions.map((entry) => entry.promise))
  for (const entry of pendingAdmissions.splice(0)) {
    entry.grant?.release()
  }
})

it('admits a small third-repository read beside repeated native status polls', async () => {
  const scheduler = new GitAdmissionScheduler({ generalCap: 4, generalHeadroom: 2 })
  const controller = new AbortController()
  const active = new Map<string, GitAdmissionGrant[]>()
  const pending: Promise<void>[] = []
  const start = (cwd: string, args: string[]) => {
    pending.push(
      scheduler.acquire({ cwd, args, signal: controller.signal }).then(
        (grant) => {
          const grants = active.get(cwd) ?? []
          grants.push(grant)
          active.set(cwd, grants)
        },
        () => {}
      )
    )
  }
  try {
    for (let index = 0; index < 4; index += 1) {
      start('/large-a', ['status', '--porcelain=v2'])
    }
    for (let index = 0; index < 4; index += 1) {
      start('/large-b', ['status', '--porcelain=v2'])
    }
    start('/small-c', ['rev-parse', '--show-toplevel'])
    await Promise.resolve()
    await Promise.resolve()
    expect(active.get('/large-a')).toHaveLength(1)
    expect(active.get('/large-b')).toHaveLength(1)
    expect(active.get('/small-c')).toHaveLength(1)
    expect(scheduler.snapshot()).toMatchObject({
      queued: 6,
      budgets: { general: { baseUsed: 3, headroomUsed: 0 } }
    })
  } finally {
    controller.abort()
    for (const grants of active.values()) {
      for (const grant of grants) {
        grant.release()
      }
    }
    await Promise.all(pending)
  }
  expect(scheduler.snapshot().queued).toBe(0)
})

it.each(['status', 'background'] as const)(
  'serializes native status polls at the %s tier',
  async (tier) => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 4 })
    const first = await start(scheduler, { ...poll(), tier }).promise
    const next = start(scheduler, { ...poll(), tier })
    await flushAdmission()
    expect(next.grant).toBeUndefined()
    expect(scheduler.snapshot().budgets.general.baseUsed).toBe(1)
    first.release()
    await expect(next.promise).resolves.toBeDefined()
  }
)

it('lets an interactive status use headroom while a poll and its backlog are blocked', async () => {
  const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 1 })
  const first = await start(scheduler, poll()).promise
  const waiting = start(scheduler, poll())
  const foreground = await start(scheduler, { ...poll(), tier: 'interactive' }).promise
  expect(scheduler.snapshot()).toMatchObject({
    queued: 1,
    budgets: { general: { baseUsed: 1, headroomUsed: 1 } }
  })
  foreground.release()
  first.release()
  await waiting.promise
})

it.each([
  ['rev-parse', '--show-toplevel'],
  ['diff', '--stat'],
  ['show', 'HEAD:status'],
  ['config', '--get', 'status.showUntrackedFiles']
])('keeps non-status %s reads parallel in the same directory', async (...args) => {
  const scheduler = new GitAdmissionScheduler({ generalCap: 4 })
  await start(scheduler, poll()).promise
  await Promise.all(
    Array.from({ length: 3 }, () => start(scheduler, { cwd: '/repo', args }).promise)
  )
  expect(scheduler.snapshot().budgets.general.baseUsed).toBe(4)
})

it.each([
  ['--no-optional-locks', 'status'],
  ['-c', 'status.renames=false', 'status'],
  ['-C', '/repo', 'status']
])('groups status with leading options %j', async (...args) => {
  const scheduler = new GitAdmissionScheduler({ generalCap: 4 })
  await start(scheduler, poll()).promise
  const next = start(scheduler, { cwd: '/repo', args })
  await flushAdmission()
  expect(next.grant).toBeUndefined()
  expect(scheduler.snapshot().queued).toBe(1)
})

it('normalizes lexical aliases without leaking the directory in admission events', async () => {
  const events: unknown[] = []
  const scheduler = new GitAdmissionScheduler({ onAdmissionEvent: (event) => events.push(event) })
  const cwd = path.resolve('private-repository')
  const first = await start(scheduler, poll(cwd)).promise
  const alias = start(scheduler, poll(path.join(cwd, 'child', '..') + path.sep))
  await flushAdmission()
  expect(alias.grant).toBeUndefined()
  expect(JSON.stringify(events)).not.toContain('private-repository')
  first.release()
  await alias.promise
})

it.runIf(process.platform === 'win32')('groups native Windows directory case aliases', async () => {
  const scheduler = new GitAdmissionScheduler()
  const cwd = path.resolve('repo')
  await start(scheduler, poll(cwd.toLowerCase())).promise
  const alias = start(scheduler, poll(cwd.toUpperCase()))
  await flushAdmission()
  expect(alias.grant).toBeUndefined()
})

it.skipIf(process.platform === 'win32')('keeps distinct POSIX path casing separate', async () => {
  const scheduler = new GitAdmissionScheduler()
  await Promise.all([
    start(scheduler, poll('/repo/UPPER')).promise,
    start(scheduler, poll('/repo/upper')).promise
  ])
  expect(scheduler.snapshot().budgets.general.baseUsed).toBe(2)
})

it('preserves aging and includes the directory wait in queue time', async () => {
  let now = 0
  const scheduler = new GitAdmissionScheduler({ generalCap: 4, now: () => now })
  const first = await start(scheduler, poll()).promise
  const aged = start(scheduler, { ...poll(), tier: 'background' })
  now = 30_000
  const fresh = start(scheduler, poll())
  first.release()
  const grant = await aged.promise
  expect(grant.queueWaitMs).toBe(30_000)
  expect(fresh.grant).toBeUndefined()
  grant.release()
  await fresh.promise
})

it('prunes a canceled directory lane and releases each poll slot only once', async () => {
  const scheduler = new GitAdmissionScheduler()
  const first = await start(scheduler, poll()).promise
  const canceled = start(scheduler, poll())
  canceled.controller.abort()
  await expect(canceled.promise).rejects.toMatchObject({ name: 'AbortError' })
  first.release()
  first.release()
  expect(scheduler.snapshot()).toMatchObject({
    queued: 0,
    budgets: { general: { baseUsed: 0, headroomUsed: 0 } }
  })
  expect(
    Object.keys(scheduler.snapshot().budgets).filter((key) => key.startsWith('route:'))
  ).toEqual([])
  await start(scheduler, poll()).promise
})

it('keeps the global cap when more distinct repositories poll than can run', async () => {
  const scheduler = new GitAdmissionScheduler({ generalCap: 2, generalHeadroom: 0 })
  const running = await Promise.all([
    start(scheduler, poll('/one')).promise,
    start(scheduler, { cwd: '/two', args: ['diff', '--stat'] }).promise
  ])
  const third = start(scheduler, poll('/three'))
  await flushAdmission()
  expect(third.grant).toBeUndefined()
  expect(scheduler.snapshot().budgets.general.baseUsed).toBe(2)
  running[0].release()
  await third.promise
  expect(scheduler.snapshot().budgets.general.baseUsed).toBe(2)
})

it.each([2, 3, 4])(
  'reserves a general slot for other reads with capacity %i',
  async (generalCap) => {
    const scheduler = new GitAdmissionScheduler({ generalCap, generalHeadroom: 0 })
    const polls = Array.from({ length: generalCap + 2 }, (_, index) =>
      start(scheduler, poll(`/large-${index}`))
    )
    const small = start(scheduler, { cwd: '/small', args: ['config', '--get', 'core.bare'] })
    await flushAdmission()
    expect(small.grant).toBeDefined()
    expect(polls.filter((entry) => entry.grant !== undefined)).toHaveLength(generalCap - 1)
    expect(scheduler.snapshot().budgets.general).toEqual({ baseUsed: generalCap, headroomUsed: 0 })
  }
)
