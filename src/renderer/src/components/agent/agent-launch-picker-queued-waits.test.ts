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
