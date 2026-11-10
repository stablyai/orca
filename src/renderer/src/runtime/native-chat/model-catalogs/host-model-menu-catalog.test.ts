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
    await owner.read(false, undefined, new AbortController().signal)
    const refresh = owner.read(false, undefined, new AbortController().signal)
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
      await owner.read(false, undefined, new AbortController().signal)
      recordHostModelCatalogSnapshot(target, 'codex', 'id:unrelated', catalog('other'))
      expect(owner.snapshot.answer).toEqual({ origin: 'unknown' })
    }
    stop()
    mocks.call.mockReset()
  }
})

it('keeps native-only answers out of guest and differing paired-command routes', async () => {
  const { agentPickerModelCatalogReads } =
    await import('@/components/agent/agent-launch-picker-host-reads')
  const { modelMenuOptions } =
    await import('../../../../../shared/agent-session/options/model-menu-options')
  const entry = {
    agent: 'codex',
    catalogRead: 'pending',
    label: 'Codex',
    rows: [],
    surfaces: ['chat', 'terminal'],
    defaultSurface: 'chat',
    terminal: {},
    structured: {},
    catalog: { origin: 'unknown' }
  } satisfies AgentPickerEntry
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
    const answer = await agentPickerModelCatalogReads(input).catalog(
      entry,
      false,
      undefined,
      new AbortController().signal
    )
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
