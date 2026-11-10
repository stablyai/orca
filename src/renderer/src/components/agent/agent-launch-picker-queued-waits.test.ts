import { expect, it, vi } from 'vitest'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: transport.call
}))
import { agentPickerModelCatalogReads } from './agent-launch-picker-host-reads'
import { observeAgentPickerAcquisition } from './agent-launch-picker-acquisition'
import {
  resetHostModelCatalogSnapshotsForTests,
  forgetHostModelCatalogSnapshots
} from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'

it('publishes all saved source catalogs before waiting, and follows an expired wait through the host adapter', async () => {
  resetHostModelCatalogSnapshotsForTests()
  const expired = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const fresh = Promise.withResolvers<AgentSessionModelCatalogResult>()
  let codexWaited = false
  transport.call.mockImplementation((_target, _method, params) => {
    if (params.waitForListing) {
      if (params.agent === 'codex' && !codexWaited) {
        codexWaited = true
        return expired.promise
      }
      return fresh.promise
    }
    return Promise.resolve({
      origin: 'probe',
      fetchedAt: 1,
      listingInProgress: true,
      listingNamesConfiguredModel: false,
      models: [{ id: `${params.agent}-saved`, label: 'Saved', isDefault: false, efforts: [] }]
    })
  })
  const entries: AgentPickerEntry[] = (['codex', 'claude', 'gemini'] as const).map((agent) => ({
    agent,
    label: agent,
    rows: [],
    surfaces: ['chat'],
    defaultSurface: 'chat',
    terminal: {},
    structured: {},
    catalog: { origin: 'unknown' }
  }))
  let published = entries
  const stop = observeAgentPickerAcquisition(
    'queued-waits-through-host-owner',
    entries,
    {
      ...agentPickerModelCatalogReads({
        target: { kind: 'local' },
        nativeRuntime: true,
        selector: 'id:queued',
        settings: {}
      }),
      support: async () => undefined
    },
    { selected: () => 'codex', publish: (next) => (published = next) }
  )
  try {
    await expect
      .poll(() =>
        published.map((entry) =>
          entry.catalog.origin !== 'unknown' ? entry.catalog.models[0]?.id : undefined
        )
      )
      .toEqual(['codex-saved', 'claude-saved', 'gemini-saved'])
    expired.resolve({ origin: 'unknown', listingInProgress: true, waitExpired: true })
    await expect
      .poll(() =>
        transport.call.mock.calls
          .filter(([, , params]) => params.agent === 'codex')
          .map(([, , params]) => params.waitForListing ?? false)
      )
      .toEqual([false, true, true])
    fresh.resolve({
      origin: 'probe',
      fetchedAt: 2,
      listingNamesConfiguredModel: false,
      models: [{ id: 'fresh', label: 'Fresh', isDefault: false, efforts: [] }]
    })
    await expect
      .poll(() => published.map((entry) => entry.catalogRead))
      .toEqual(['settled', 'settled', 'settled'])
    expect(
      published.map((entry) =>
        entry.catalog.origin !== 'unknown' ? entry.catalog.models[0]?.id : undefined
      )
    ).toEqual(['fresh', 'fresh', 'fresh'])
  } finally {
    stop()
    expired.resolve({ origin: 'unknown' })
    fresh.resolve({ origin: 'unknown' })
  }
})

it('keeps the new account listing pending when its obsolete predecessor settles', async () => {
  resetHostModelCatalogSnapshotsForTests()
  const target = { kind: 'local' } as const
  const first = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const second = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const firstStarted = Promise.withResolvers<void>()
  const secondStarted = Promise.withResolvers<void>()
  transport.call
    .mockReset()
    .mockImplementationOnce(() => {
      firstStarted.resolve()
      return first.promise
    })
    .mockImplementationOnce(() => {
      secondStarted.resolve()
      return second.promise
    })
  const entries: AgentPickerEntry[] = [
    {
      agent: 'codex',
      label: 'Codex',
      rows: [],
      surfaces: ['chat'],
      defaultSurface: 'chat',
      terminal: {},
      structured: {},
      catalog: { origin: 'unknown' }
    }
  ]
  const host = agentPickerModelCatalogReads({
    target,
    nativeRuntime: true,
    selector: 'id:account-replacement',
    settings: {}
  })
  let firstRead = true
  let obsoleteSettled = false
  let published = entries
  const afterObsolete = Promise.withResolvers<AgentPickerEntry[]>()
  const inFlight: Promise<AgentSessionModelCatalogResult | undefined>[] = []
  const stop = observeAgentPickerAcquisition(
    'account-replacement-through-host-owner',
    entries,
    {
      ...host,
      catalog: (...args: Parameters<typeof host.catalog>) => {
        const original = firstRead
        firstRead = false
        const reading = host.catalog(...args).then((answer) => {
          if (original) {
            obsoleteSettled = true
          }
          return answer
        })
        inFlight.push(reading)
        return reading
      },
      support: async () => undefined
    },
    {
      selected: () => 'codex',
      publish: (next) => {
        published = next
        if (obsoleteSettled) {
          afterObsolete.resolve(next)
        }
      }
    }
  )
  try {
    await firstStarted.promise
    forgetHostModelCatalogSnapshots(target, ['codex'])
    await secondStarted.promise
    first.resolve({
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'old-account', label: 'Old', isDefault: false, efforts: [] }]
    })
    expect(await afterObsolete.promise).toMatchObject([
      {
        catalogRead: 'pending',
        catalog: { origin: 'unknown' }
      }
    ])
    second.resolve({
      origin: 'probe',
      fetchedAt: 2,
      models: [{ id: 'new-account', label: 'New', isDefault: false, efforts: [] }]
    })
    await expect
      .poll(() => published)
      .toMatchObject([
        {
          catalogRead: 'settled',
          catalog: { origin: 'probe', models: [{ id: 'new-account' }] }
        }
      ])
  } finally {
    stop()
    first.resolve({ origin: 'unknown' })
    second.resolve({ origin: 'unknown' })
    await Promise.allSettled(inFlight)
  }
})
