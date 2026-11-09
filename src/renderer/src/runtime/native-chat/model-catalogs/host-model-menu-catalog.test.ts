import type { AgentPickerEntry } from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('../host-capabilities/structured-agent-session-host-capability', () => ({
  structuredAgentSessionHostKey: (target: { kind: string; environmentId?: string }) =>
    target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}))
import { hostModelMenuCatalog } from './host-model-menu-catalog'
import {
  forgetHostModelCatalogSnapshots,
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from './host-model-catalog-snapshots'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
const target = { kind: 'local' } as const
const catalog = (id: string): AgentSessionModelCatalogResult => ({
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: false,
  models: [{ id, label: id, isDefault: false, efforts: [] }]
})
beforeEach(() => {
  mocks.call.mockReset()
  resetHostModelCatalogSnapshotsForTests()
})

it.each([3, 30])(
  'shares a catalog read among %i same-scope observers; waits only after listing is reported',
  async (count) => {
    const complete = Promise.withResolvers<AgentSessionModelCatalogResult>()
    mocks.call.mockImplementation((_target, _method, params) =>
      params.waitForListing
        ? complete.promise
        : Promise.resolve({ origin: 'unknown', listingInProgress: true })
    )
    const owners = Array.from({ length: count }, () =>
      hostModelMenuCatalog({ target, agent: 'codex' })
    )
    const stops = owners.map((owner) => owner.subscribe(() => {}))
    const reads = owners.map((owner) => owner.read())
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual([
      { agent: 'codex' },
      { agent: 'codex', waitForListing: true }
    ])
    complete.resolve(catalog('account-only'))
    await Promise.all(reads)
    expect(owners[0].snapshot.answer).toMatchObject({ models: [{ id: 'account-only' }] })
    stops.forEach((stop) => stop())
  }
)

it('scopes notifications to a host/agent and suppresses unchanged answers', () => {
  const a = hostModelMenuCatalog({ target, agent: 'codex' })
  const b = hostModelMenuCatalog({
    target: { kind: 'environment', environmentId: 'B' },
    agent: 'codex'
  })
  const onA = vi.fn(),
    onB = vi.fn()
  const stopA = a.subscribe(onA),
    stopB = b.subscribe(onB)
  recordHostModelCatalogSnapshot(target, 'codex', null, catalog('first'))
  expect(onA).toHaveBeenCalledTimes(1)
  expect(onB).not.toHaveBeenCalled()
  recordHostModelCatalogSnapshot(target, 'codex', null, catalog('first'))
  expect(onA).toHaveBeenCalledTimes(1)
  stopA()
  stopB()
})

it('drops a late reply after an account switch and consumes a plain legacy listing', async () => {
  const old = Promise.withResolvers<AgentSessionModelCatalogResult>()
  mocks.call.mockReturnValueOnce(old.promise).mockResolvedValueOnce(catalog('new-account'))
  const owner = hostModelMenuCatalog({ target, agent: 'codex' })
  const stop = owner.subscribe(() => {})
  const pending = owner.read()
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
  forgetHostModelCatalogSnapshots(target)
  await owner.read()
  old.resolve(catalog('old-account'))
  await pending
  expect(owner.snapshot.answer).toMatchObject({ models: [{ id: 'new-account' }] })
  expect(mocks.call).toHaveBeenCalledTimes(2)
  expect(mocks.call.mock.calls.every((call) => call[2].waitForListing === undefined)).toBe(true)
  stop()
})

it('keeps a last-good catalog through a pending refresh and transport failure', async () => {
  const wait = Promise.withResolvers<AgentSessionModelCatalogResult>()
  mocks.call
    .mockResolvedValueOnce(catalog('last-good'))
    .mockResolvedValueOnce({ origin: 'unknown', listingInProgress: true })
    .mockReturnValueOnce(wait.promise)
  const owner = hostModelMenuCatalog({ target, agent: 'codex', worktree: 'id:refresh' })
  const stop = owner.subscribe(() => {})
  await owner.read()
  const refresh = owner.read()
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3))
  expect(owner.snapshot.answer).toMatchObject({ models: [{ id: 'last-good' }] })
  expect(owner.snapshot.pending).toBe(true)
  wait.reject(new Error('transport offline'))
  expect(await refresh).toMatchObject({ models: [{ id: 'last-good' }] })
  expect(owner.snapshot).toMatchObject({
    pending: false,
    attempted: true,
    answer: { models: [{ id: 'last-good' }] }
  })
  stop()
})

it('never restores a catalog retired or invalidated during a failed refresh', async () => {
  for (const invalidate of ['empty', 'unknown', 'account'] as const) {
    const wait = Promise.withResolvers<AgentSessionModelCatalogResult>()
    mocks.call
      .mockResolvedValueOnce(catalog('old'))
      .mockResolvedValueOnce({ origin: 'unknown', listingInProgress: true })
      .mockReturnValueOnce(wait.promise)
    const worktree = `id:${invalidate}`
    const owner = hostModelMenuCatalog({ target, agent: 'codex', worktree })
    const stop = owner.subscribe(() => {})
    await owner.read()
    const refresh = owner.read()
    await vi.waitFor(() => expect(mocks.call.mock.calls.at(-1)?.[2].waitForListing).toBe(true))
    if (invalidate !== 'account') {
      recordHostModelCatalogSnapshot(
        target,
        'codex',
        worktree,
        invalidate === 'unknown'
          ? { origin: 'unknown' }
          : { origin: 'probe', fetchedAt: 2, models: [] }
      )
    } else {
      forgetHostModelCatalogSnapshots(target)
    }
    wait.reject(new Error('transport offline'))
    await refresh
    expect(owner.snapshot.answer).toEqual(
      invalidate === 'empty'
        ? { origin: 'probe', fetchedAt: 2, models: [] }
        : invalidate === 'unknown'
          ? { origin: 'unknown' }
          : undefined
    )
    if (invalidate === 'unknown') {
      mocks.call
        .mockResolvedValueOnce({ origin: 'unknown', listingInProgress: true })
        .mockRejectedValueOnce(new Error('still offline'))
      await owner.read()
      recordHostModelCatalogSnapshot(target, 'codex', 'id:unrelated', catalog('other'))
      expect(owner.snapshot.answer).toEqual({ origin: 'unknown' })
    }
    stop()
    mocks.call.mockReset()
  }
})

it.each([75, 750])(
  'compares only changed catalog payloads with %i retained workspaces',
  (count) => {
    let visits = 0
    const answer = (changed = false): AgentSessionModelCatalogResult => ({
      origin: 'probe',
      fetchedAt: 1,
      modelsDifferByWorkspace: true,
      models: Array.from({ length: 20 }, (_, index) => ({
        id: `${changed ? 'new' : 'old'}-${index}`,
        get label() {
          visits += 1
          return 'Model'
        },
        isDefault: false,
        efforts: []
      }))
    })
    for (let i = 0; i < count; i += 1) {
      recordHostModelCatalogSnapshot(target, 'codex', `id:wt-${i}`, answer())
    }
    visits = 0
    recordHostModelCatalogSnapshot(target, 'codex', 'id:wt-0', answer())
    recordHostModelCatalogSnapshot(target, 'codex', 'id:wt-0', answer(true))
    expect(visits).toBeLessThanOrEqual(80)
    const held = readHostModelCatalogSnapshot(target, 'codex', {
      newLaunch: true,
      seedsModel: true,
      worktree: 'id:wt-0'
    })
    expect(held?.origin !== 'unknown' && held?.models[0].id).toBe('new-0')
  }
)

it('keeps native-only answers out of guest and differing paired-command routes', async () => {
  const { agentPickerModelCatalogReads } =
    await import('@/components/agent/agent-launch-picker-host-reads')
  const { modelMenuOptions } =
    await import('../../../../../shared/agent-session/options/model-menu-options')
  const entry = {
    agent: 'codex',
    catalogRead: 'pending'
  } as AgentPickerEntry
  mocks.call.mockResolvedValue(catalog('native-only'))
  for (const input of [
    { target, nativeRuntime: false, settings: {} },
    {
      target: { kind: 'environment' as const, environmentId: 'windows-host' },
      nativeRuntime: false,
      settings: {}
    },
    {
      target: { kind: 'environment' as const, environmentId: 'different-command' },
      nativeRuntime: true,
      settings: { agentCmdOverrides: { codex: '/client/codex' } },
      serverSettings: async () => ({ agentCmdOverrides: { codex: '/server/codex' } })
    }
  ]) {
    const answer = await agentPickerModelCatalogReads(input).catalog(entry)
    const menu = modelMenuOptions(answer, {
      agent: 'codex',
      surface: 'terminal',
      newLaunch: true,
      seedsModel: true,
      seed: { models: [{ id: 'guest-only', label: 'Guest', options: [] }], modelApply: {} }
    })
    expect(menu.rows.map((row) => row.id)).toEqual(['guest-only'])
  }
  expect(mocks.call).not.toHaveBeenCalled()
})
