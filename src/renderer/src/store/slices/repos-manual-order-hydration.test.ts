import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { createTestStore } from './store-test-helpers'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const reposList = vi.fn()
const projectsList = vi.fn()
const listHostSetups = vi.fn()
const runtimeEnvironmentsList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const reposByEnvironment: Record<string, Repo[]> = {
  'node-a': [
    { id: 'alpha', path: '/alpha', displayName: 'alpha', badgeColor: '#000', addedAt: 1 },
    { id: 'bravo', path: '/bravo', displayName: 'bravo', badgeColor: '#000', addedAt: 2 }
  ],
  'node-b': [
    { id: 'charlie', path: '/charlie', displayName: 'charlie', badgeColor: '#000', addedAt: 1 },
    { id: 'delta', path: '/delta', displayName: 'delta', badgeColor: '#000', addedAt: 2 }
  ]
}

type RepoListResolver = (value: unknown) => void

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset().mockResolvedValue([])
  projectsList.mockReset().mockResolvedValue([])
  listHostSetups.mockReset().mockResolvedValue([])
  runtimeEnvironmentsList.mockReset().mockResolvedValue([
    { id: 'node-a', name: 'A' },
    { id: 'node-b', name: 'B' }
  ])
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation(
    (args: RuntimeEnvironmentCallRequest) =>
      createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  )
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups },
      runtimeEnvironments: {
        list: runtimeEnvironmentsList,
        call: runtimeEnvironmentTransportCall
      }
    }
  })
})

async function loadWithCompletionOrder(completionOrder: string[]): Promise<string[]> {
  clearRuntimeCompatibilityCacheForTests()
  const repoListResolvers = new Map<string, RepoListResolver>()
  runtimeEnvironmentCall.mockImplementation(
    (args: RuntimeEnvironmentCallRequest & { selector?: string }) => {
      if (args.method === 'repo.list' && args.selector) {
        return new Promise((resolve) => repoListResolvers.set(args.selector!, resolve))
      }
      const result = args.method === 'project.list' ? { projects: [] } : { setups: [] }
      return { id: `rpc-${args.method}`, ok: true, result, _meta: { runtimeId: 'runtime' } }
    }
  )
  const store = createTestStore()
  store.setState({
    manualRepoOrder: [
      { hostId: 'runtime:node-a', repoId: 'alpha' },
      { hostId: 'runtime:node-b', repoId: 'charlie' },
      { hostId: 'runtime:node-a', repoId: 'bravo' },
      { hostId: 'runtime:node-b', repoId: 'delta' }
    ]
  })

  const load = store.getState().fetchReposForAllHosts()
  await vi.waitFor(() => expect(repoListResolvers.size).toBe(2))
  for (const environmentId of completionOrder) {
    repoListResolvers.get(environmentId)?.({
      id: `rpc-repo-${environmentId}`,
      ok: true,
      result: { repos: reposByEnvironment[environmentId] },
      _meta: { runtimeId: environmentId }
    })
    await Promise.resolve()
  }
  await load
  expect(store.getState().manualRepoOrder).toHaveLength(4)
  return store.getState().repos.map((repo) => `${repo.executionHostId}:${repo.id}`)
}

describe('manual repo order hydration', () => {
  it('restores the same cross-host order for either catalog completion order', async () => {
    const expected = [
      'runtime:node-a:alpha',
      'runtime:node-b:charlie',
      'runtime:node-a:bravo',
      'runtime:node-b:delta'
    ]

    await expect(loadWithCompletionOrder(['node-b', 'node-a'])).resolves.toEqual(expected)
    await expect(loadWithCompletionOrder(['node-a', 'node-b'])).resolves.toEqual(expected)
  })
})
