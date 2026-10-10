import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { createCompatibleRuntimeStatusResponse } from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '../../runtime/runtime-environment-revision'
import { createTestStore } from './store-test-helpers'

const qualifiedCapability = 'repo.update.execution-host.v1'
const publisher = 'runtime:paired' as const
const privateA: Repo = {
  id: 'shared-id',
  path: '/private/a',
  displayName: 'Private A',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: publisher,
  catalogOwnerHostId: publisher,
  authoritativeExecutionHostId: 'ssh:private-a'
}
const privateB: Repo = {
  ...privateA,
  path: '/private/b',
  displayName: 'Private B',
  authoritativeExecutionHostId: 'ssh:private-b'
}
const selectedB = {
  hostId: publisher,
  catalogOwnerHostId: publisher,
  authoritativeExecutionHostId: 'ssh:private-b' as const
}
const transport = vi.fn()
const mutation = vi.fn()
const localUpdate = vi.fn()
let capabilities: string[]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function response(repo: Repo) {
  return { id: 'update', ok: true, result: { repo }, _meta: { runtimeId: 'paired-runtime' } }
}

function rawRepo(repo: Repo): Repo {
  const { catalogOwnerHostId: _publisher, authoritativeExecutionHostId, ...row } = repo
  return { ...row, executionHostId: authoritativeExecutionHostId }
}

function compatibleStatus() {
  const status = createCompatibleRuntimeStatusResponse('paired-runtime')
  if (!status.ok) {
    throw new Error('Expected compatible runtime status fixture')
  }
  return { ...status, result: { ...status.result, capabilities } }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1, pairingRevision: 10 }])
  capabilities = [qualifiedCapability]
  transport.mockReset()
  mutation.mockReset()
  localUpdate.mockReset()
  transport.mockImplementation((args: { method: string }) => {
    if (args.method !== 'status.get') {
      return mutation(args)
    }
    return compatibleStatus()
  })
  mutation.mockResolvedValue(response({ ...rawRepo(privateB), displayName: 'Renamed B' }))
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { call: transport }, repos: { update: localUpdate } }
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  replaceRuntimeEnvironmentRevisions([])
})

describe('repo update selected owner authority', () => {
  it.each([false, true])(
    'updates only selected private B with reverse order %s',
    async (reverse) => {
      const store = createTestStore()
      store.setState({ repos: reverse ? [privateB, privateA] : [privateA, privateB] })

      await expect(
        store.getState().updateRepo('shared-id', { displayName: 'Renamed B' }, selectedB)
      ).resolves.toBe(true)

      expect(mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'paired',
          method: 'repo.update',
          params: {
            repo: 'shared-id',
            executionHostId: 'ssh:private-b',
            updates: { displayName: 'Renamed B' }
          },
          expectedEnvironmentPairingRevision: 10
        })
      )
      expect(store.getState().repos.find((row) => row.path === privateA.path)).toEqual(privateA)
      expect(store.getState().repos.find((row) => row.path === privateB.path)).toEqual({
        ...privateB,
        displayName: 'Renamed B'
      })
      expect(
        store.getState().projectHostSetups.find((setup) => setup.path === privateA.path)
          ?.executionHostId
      ).toBe('ssh:private-a')
      expect(
        store.getState().projectHostSetups.find((setup) => setup.path === privateB.path)
          ?.executionHostId
      ).toBe('ssh:private-b')
    }
  )

  it('refuses an older peer before its schema can strip the qualifier', async () => {
    capabilities = capabilities.filter((capability) => capability !== qualifiedCapability)
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    await expect(
      store.getState().updateRepo('shared-id', { displayName: 'Renamed B' }, selectedB)
    ).resolves.toBe(false)
    expect(mutation).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual([privateA, privateB])
  })

  it.each([
    { name: 'missing raw host', options: { hostId: publisher } },
    {
      name: 'unknown raw host',
      options: { ...selectedB, authoritativeExecutionHostId: 'ssh:missing' as const }
    },
    {
      name: 'wrong publisher',
      options: { ...selectedB, catalogOwnerHostId: 'runtime:other' as const }
    },
    {
      name: 'malformed host',
      options: { ...selectedB, authoritativeExecutionHostId: 'ssh:' as const }
    }
  ])('refuses $name without sending or updating a sibling', async ({ options }) => {
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    await expect(
      store.getState().updateRepo('shared-id', { displayName: 'Wrong' }, options)
    ).resolves.toBe(false)
    expect(mutation).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual([privateA, privateB])
  })

  it('refuses duplicate exact owner rows', async () => {
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB, { ...privateB, path: '/duplicate' }] })
    await expect(
      store.getState().updateRepo('shared-id', { displayName: 'Wrong' }, selectedB)
    ).resolves.toBe(false)
    expect(mutation).not.toHaveBeenCalled()
  })

  it('does not merge a response from another raw owner', async () => {
    mutation.mockResolvedValue(response({ ...rawRepo(privateA), displayName: 'Wrong owner' }))
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    await expect(
      store.getState().updateRepo('shared-id', { displayName: 'Renamed B' }, selectedB)
    ).resolves.toBe(false)
    expect(store.getState().repos).toEqual([privateA, privateB])
  })

  it.each([
    { name: 'another repo', repo: { ...rawRepo(privateB), id: 'another-id' } },
    {
      name: 'contradictory authority',
      repo: { ...rawRepo(privateA), authoritativeExecutionHostId: 'ssh:private-b' as const }
    }
  ])('does not merge $name response', async ({ repo }) => {
    mutation.mockResolvedValue(response(repo))
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    await expect(
      store.getState().updateRepo('shared-id', { displayName: 'Wrong' }, selectedB)
    ).resolves.toBe(false)
    expect(store.getState().repos).toEqual([privateA, privateB])
  })

  it('does not optimistically merge a missing qualified response', async () => {
    mutation.mockResolvedValue({ id: 'missing', ok: true, result: {} })
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    await expect(
      store.getState().updateRepo('shared-id', { displayName: 'Wrong' }, selectedB)
    ).resolves.toBe(false)
    expect(store.getState().repos).toEqual([privateA, privateB])
  })

  it('does not merge a late response after the captured owner was removed', async () => {
    const reply = deferred<ReturnType<typeof response>>()
    mutation.mockReturnValue(reply.promise)
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    const updating = store
      .getState()
      .updateRepo('shared-id', { displayName: 'Renamed B' }, selectedB)
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    store.setState({ repos: [privateA] })
    reply.resolve(response({ ...rawRepo(privateB), displayName: 'Renamed B' }))
    await expect(updating).resolves.toBe(false)
    expect(store.getState().repos).toEqual([privateA])
  })

  it.each([false, true])(
    'does not merge a removed and re-added owner with reverse order %s',
    async (reverse) => {
      const reply = deferred<ReturnType<typeof response>>()
      mutation.mockReturnValue(reply.promise)
      const store = createTestStore()
      store.setState({ repos: reverse ? [privateB, privateA] : [privateA, privateB] })
      const updating = store
        .getState()
        .updateRepo('shared-id', { displayName: 'Old reply' }, selectedB)
      await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
      const replacement = { ...privateB, displayName: 'Replacement B', addedAt: 2 }
      store.setState({ repos: reverse ? [replacement, privateA] : [privateA, replacement] })
      reply.resolve(response({ ...rawRepo(privateB), displayName: 'Old reply' }))
      await expect(updating).resolves.toBe(false)
      expect(store.getState().repos.find((repo) => repo.path === privateB.path)).toEqual(
        replacement
      )
      expect(store.getState().repos.find((repo) => repo.path === privateA.path)).toEqual(privateA)
    }
  )

  it.each([false, true])(
    'accepts a metadata refresh of the same owner with reverse order %s',
    async (reverse) => {
      const reply = deferred<ReturnType<typeof response>>()
      mutation.mockReturnValue(reply.promise)
      const store = createTestStore()
      store.setState({ repos: reverse ? [privateB, privateA] : [privateA, privateB] })
      const updating = store
        .getState()
        .updateRepo('shared-id', { displayName: 'Renamed B' }, selectedB)
      await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
      const refreshed = { ...privateB, displayName: 'Renamed B' }
      store.setState({ repos: reverse ? [refreshed, privateA] : [privateA, refreshed] })
      reply.resolve(response(rawRepo(refreshed)))
      await expect(updating).resolves.toBe(true)
      expect(store.getState().repos.find((repo) => repo.path === privateB.path)).toEqual(refreshed)
      expect(store.getState().repos.find((repo) => repo.path === privateA.path)).toEqual(privateA)
    }
  )

  it.each([false, true])(
    'refuses queued updates captured before owner replacement with reverse order %s',
    async (reverse) => {
      const reply = deferred<ReturnType<typeof response>>()
      mutation.mockReturnValue(reply.promise)
      const store = createTestStore()
      store.setState({ repos: reverse ? [privateB, privateA] : [privateA, privateB] })
      const first = store.getState().updateRepo('shared-id', { displayName: 'First' }, selectedB)
      const second = store.getState().updateRepo('shared-id', { displayName: 'Queued' }, selectedB)
      await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
      const replacement = { ...privateB, displayName: 'Replacement B', addedAt: 2 }
      store.setState({ repos: reverse ? [replacement, privateA] : [privateA, replacement] })
      reply.resolve(response({ ...rawRepo(privateB), displayName: 'First' }))
      await expect(Promise.all([first, second])).resolves.toEqual([false, false])
      expect(mutation).toHaveBeenCalledTimes(1)
      expect(store.getState().repos.find((repo) => repo.path === privateB.path)).toEqual(
        replacement
      )
    }
  )

  it('refuses a re-pair during the capability probe before sending the update', async () => {
    const status = deferred<ReturnType<typeof compatibleStatus>>()
    transport.mockImplementation((args: { method: string }) =>
      args.method === 'status.get' ? status.promise : mutation(args)
    )
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    const updating = store
      .getState()
      .updateRepo('shared-id', { displayName: 'Renamed B' }, selectedB)
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1))
    replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1, pairingRevision: 11 }], {
      retired: ['paired'],
      sameHost: []
    })
    status.resolve(compatibleStatus())
    await expect(updating).resolves.toBe(false)
    expect(mutation).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual([privateA, privateB])
  })

  it('accepts a pairing rotation proven to continue the same host', async () => {
    const status = deferred<ReturnType<typeof compatibleStatus>>()
    transport.mockImplementation((args: { method: string }) =>
      args.method === 'status.get' ? status.promise : mutation(args)
    )
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    const updating = store
      .getState()
      .updateRepo('shared-id', { displayName: 'Renamed B' }, selectedB)
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1))
    replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1, pairingRevision: 11 }], {
      retired: [],
      sameHost: [{ id: 'paired', fromRevision: 10, toRevision: 11 }]
    })
    status.resolve(compatibleStatus())
    await expect(updating).resolves.toBe(true)
    expect(mutation).toHaveBeenCalledWith(
      expect.objectContaining({ expectedEnvironmentPairingRevision: 10 })
    )
  })

  it('refuses a newly duplicated owner after the capability probe', async () => {
    const status = deferred<ReturnType<typeof compatibleStatus>>()
    transport.mockImplementation((args: { method: string }) =>
      args.method === 'status.get' ? status.promise : mutation(args)
    )
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    const updating = store.getState().updateRepo('shared-id', { displayName: 'Wrong' }, selectedB)
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1))
    store.setState({ repos: [privateA, privateB, { ...privateB, path: '/new-duplicate' }] })
    status.resolve(compatibleStatus())
    await expect(updating).resolves.toBe(false)
    expect(mutation).not.toHaveBeenCalled()
  })

  it('does not merge a late response after a re-pair', async () => {
    const reply = deferred<ReturnType<typeof response>>()
    mutation.mockReturnValue(reply.promise)
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    const updating = store.getState().updateRepo('shared-id', { displayName: 'Wrong' }, selectedB)
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1, pairingRevision: 11 }], {
      retired: ['paired'],
      sameHost: []
    })
    reply.resolve(response({ ...rawRepo(privateB), displayName: 'Wrong' }))
    await expect(updating).resolves.toBe(false)
    expect(store.getState().repos).toEqual([privateA, privateB])
  })

  it('serializes queued B updates without retargeting a newly inserted sibling', async () => {
    const firstReply = deferred<ReturnType<typeof response>>()
    mutation.mockReturnValueOnce(firstReply.promise)
    mutation.mockResolvedValueOnce(response({ ...rawRepo(privateB), displayName: 'Second B' }))
    const store = createTestStore()
    store.setState({ repos: [privateB] })
    const first = store.getState().updateRepo('shared-id', { displayName: 'First B' }, selectedB)
    const second = store.getState().updateRepo('shared-id', { displayName: 'Second B' }, selectedB)
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    store.setState({ repos: [privateA, privateB] })
    firstReply.resolve(response({ ...rawRepo(privateB), displayName: 'First B' }))
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(mutation).toHaveBeenCalledTimes(2)
    expect(store.getState().repos).toEqual([privateA, { ...privateB, displayName: 'Second B' }])
  })

  it('runs private A and B queues independently and keeps captured B through row reorder', async () => {
    const aReply = deferred<ReturnType<typeof response>>()
    mutation.mockImplementation((args: { params: { executionHostId?: string } }) =>
      args.params.executionHostId === 'ssh:private-a'
        ? aReply.promise
        : response({ ...rawRepo(privateB), displayName: 'Renamed B' })
    )
    const store = createTestStore()
    store.setState({ repos: [privateA, privateB] })
    const a = store.getState().updateRepo(
      'shared-id',
      { displayName: 'Renamed A' },
      {
        ...selectedB,
        authoritativeExecutionHostId: 'ssh:private-a'
      }
    )
    const b = store.getState().updateRepo('shared-id', { displayName: 'Renamed B' }, selectedB)
    store.setState({ repos: [privateB, privateA] })
    await expect(b).resolves.toBe(true)
    expect(mutation).toHaveBeenCalledTimes(2)
    aReply.resolve(response({ ...rawRepo(privateA), displayName: 'Renamed A' }))
    await expect(a).resolves.toBe(true)
    expect(store.getState().repos.map((row) => row.displayName)).toEqual(['Renamed B', 'Renamed A'])
  })

  it('preserves queued legacy updates when the first response adds raw ownership', async () => {
    const {
      authoritativeExecutionHostId: _raw,
      catalogOwnerHostId: _publisher,
      ...legacy
    } = privateB
    const firstReply = deferred<ReturnType<typeof response>>()
    const secondReply = deferred<ReturnType<typeof response>>()
    mutation.mockReturnValueOnce(firstReply.promise)
    mutation.mockReturnValueOnce(secondReply.promise)
    mutation.mockResolvedValueOnce(response({ ...rawRepo(privateB), displayName: 'Third' }))
    const store = createTestStore()
    store.setState({ repos: [legacy] })
    const first = store
      .getState()
      .updateRepo('shared-id', { displayName: 'First' }, { hostId: publisher })
    const second = store
      .getState()
      .updateRepo('shared-id', { displayName: 'Second' }, { hostId: publisher })
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    firstReply.resolve(response({ ...rawRepo(privateB), displayName: 'First' }))
    await first
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(2))
    const third = store.getState().updateRepo('shared-id', { displayName: 'Third' }, selectedB)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(mutation).toHaveBeenCalledTimes(2)
    secondReply.resolve(response({ ...rawRepo(privateB), displayName: 'Second' }))
    await expect(Promise.all([second, third])).resolves.toEqual([true, true])
    expect(store.getState().repos[0]?.displayName).toBe('Third')
  })
})
