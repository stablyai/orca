import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('node:os')
  vi.resetModules()
})

it.each([
  [undefined, 2],
  [() => 6, 2],
  [() => 32, 4]
] as const)(
  'loads the scheduler with parallelism API %s and capacity %i',
  async (api, capacity) => {
    vi.resetModules()
    vi.doMock('node:os', () => ({ availableParallelism: api }))
    const { GENERAL_CAP, GitAdmissionScheduler } = await import('./git-admission-scheduler.js')
    expect(GENERAL_CAP).toBe(capacity)
    const scheduler = new GitAdmissionScheduler()
    const grant = await scheduler.acquire({ args: ['status'], cwd: '/repo' })
    expect(scheduler.snapshot().budgets.general.baseUsed).toBe(1)
    grant.release()
    expect(scheduler.snapshot().budgets.general.baseUsed).toBe(0)
  }
)
