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
