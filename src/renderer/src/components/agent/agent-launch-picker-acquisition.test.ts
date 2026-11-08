import { expect, it } from 'vitest'
import {
  currentAgentPickerAcquisition,
  observeAgentPickerAcquisition
} from './agent-launch-picker-acquisition'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

const model = (id: string) => ({ id, label: id, isDefault: false, efforts: [] })

const codex: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'cli' }],
  surfaces: ['terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  catalog: { origin: 'unknown' }
}

it('reopens during a refreshing cached reply and publishes the refreshed listing', async () => {
  const fresh = Promise.withResolvers<AgentPickerEntry['catalog']>()
  let published: AgentPickerEntry[] = []
  const observe = () =>
    observeAgentPickerAcquisition(
      'interim-catalog',
      [codex],
      {
        catalog: async (_entry, waitForListing) =>
          waitForListing
            ? fresh.promise
            : {
                origin: 'probe',
                fetchedAt: 1,
                listingInProgress: true,
                models: [model('saved')]
              },
        support: async () => undefined
      },
      { selected: () => undefined, publish: (entries) => (published = entries) }
    )
  const stop = observe()
  stop()
  const stopReopened = await Promise.resolve().then(observe)

  await expect.poll(() => published[0].catalog).toMatchObject({ models: [{ id: 'saved' }] })
  expect(published[0].catalogRead).toBe('pending')

  fresh.resolve({ origin: 'probe', fetchedAt: 2, models: [model('fresh')] })
  await expect.poll(() => published[0].catalogRead).toBe('settled')
  expect(published[0].catalog).toMatchObject({ models: [{ id: 'fresh' }] })
  stopReopened()
})

it('settles closed catalog reads and resumes their refresh when the picker reopens', async () => {
  const unknown = Promise.withResolvers<AgentPickerEntry['catalog']>()
  const refreshing = Promise.withResolvers<AgentPickerEntry['catalog']>()
  const fresh = Promise.withResolvers<AgentPickerEntry['catalog']>()
  const support = Promise.withResolvers<AgentPickerEntry['structured']>()
  const entries: AgentPickerEntry[] = [
    { ...codex, structuredDefaultsPending: true },
    { ...codex, agent: 'claude', label: 'Claude', rows: [{ agent: 'claude', kind: 'cli' }] }
  ]
  const reads = {
    catalog: (entry: AgentPickerEntry, waitForListing: boolean) =>
      waitForListing
        ? fresh.promise
        : entry.agent === 'codex'
          ? unknown.promise
          : refreshing.promise,
    support: () => support.promise
  }
  let published: AgentPickerEntry[] = []
  const observer = {
    selected: () => undefined,
    publish: (entries: AgentPickerEntry[]) => (published = entries)
  }
  const stop = observeAgentPickerAcquisition('closed-catalog', entries, reads, observer)
  stop()

  unknown.resolve({ origin: 'unknown', listingInProgress: true })
  refreshing.resolve({
    origin: 'probe',
    fetchedAt: 1,
    listingInProgress: true,
    models: [model('saved')]
  })
  await expect
    .poll(() => currentAgentPickerAcquisition('closed-catalog')?.map((entry) => entry.catalogRead))
    .toEqual(['settled', 'settled'])

  const stopReopened = observeAgentPickerAcquisition('closed-catalog', entries, reads, observer)
  expect(published.map((entry) => entry.catalogRead)).toEqual(['pending', 'pending'])
  fresh.resolve({ origin: 'probe', fetchedAt: 2, models: [model('fresh')] })
  support.resolve({})
  await expect
    .poll(() => published.map((entry) => ({ read: entry.catalogRead, catalog: entry.catalog })))
    .toMatchObject([
      { read: 'settled', catalog: { models: [{ id: 'fresh' }] } },
      { read: 'settled', catalog: { models: [{ id: 'fresh' }] } }
    ])
  stopReopened()
  expect(currentAgentPickerAcquisition('closed-catalog')).toBeUndefined()
})
