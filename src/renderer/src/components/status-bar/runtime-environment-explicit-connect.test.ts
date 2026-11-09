import { expect, it, vi } from 'vitest'
import {
  connectRuntimeEnvironmentAndRecordStatus,
  connectRuntimeHostForNavigation
} from './runtime-environment-explicit-connect'
const { setStatus } = vi.hoisted(() => ({ setStatus: vi.fn() }))
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ setRuntimeEnvironmentStatus: setStatus }) }
}))

it('does not publish an obsolete status when Stop cancelled the pending connect', async () => {
  let resolveConnect: (value: unknown) => void = () => undefined
  const request = new Promise((resolve) => {
    resolveConnect = resolve
  })
  vi.stubGlobal('window', { api: { runtimeEnvironments: { connect: vi.fn(() => request) } } })
  const controller = new AbortController()
  const result = connectRuntimeEnvironmentAndRecordStatus('host', 5000, controller.signal)
  controller.abort()
  resolveConnect({
    id: 'status.get',
    ok: false,
    error: { code: 'runtime_manually_disconnected', message: 'Disconnected' }
  })
  expect(await result).toBe(false)
  expect(setStatus).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

it('stops subsequent catalog dispatch after Stop during a multi-batch project refresh', async () => {
  const controller = new AbortController()
  const resolvers: (() => void)[] = []
  const reached: string[] = []
  const fetchWorktrees = (repoId: string) => {
    reached.push(repoId)
    return new Promise<void>((resolve) => {
      resolvers.push(resolve)
    })
  }
  const fetchLineage = vi.fn(async () => undefined)
  const result = connectRuntimeHostForNavigation({
    environmentId: 'host',
    signal: controller.signal,
    refreshStatus: async () => true,
    fetchRepos: async () => Array.from({ length: 16 }, (_, index) => ({ id: String(index) })),
    fetchWorktrees,
    fetchLineage
  })
  await vi.waitFor(() => expect(reached).toContain('14'))
  controller.abort()
  for (const resolve of resolvers) {
    resolve()
  }
  expect(await result).toBe(false)
  expect(reached).not.toContain('15')
  expect(fetchLineage).not.toHaveBeenCalled()
})
