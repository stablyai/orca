import { expect, it, onTestFinished, vi } from 'vitest'
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
    .poll(() => currentAgentPickerAcquisition('closed-catalog')?.map((entry) => entry.catalog))
    .toEqual([
      { origin: 'unknown', listingInProgress: true },
      {
        origin: 'probe',
        fetchedAt: 1,
        listingInProgress: true,
        models: [{ id: 'saved', label: 'saved', isDefault: false, efforts: [] }]
      }
    ])

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

it('waits again only when a wait outlasted its budget, then stops once the listing has ended', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const saved = { origin: 'probe' as const, fetchedAt: 1, models: [model('saved')] }
  // A floating folder's quick read always reports a listing; only waiting reads know it ended.
  const waits = [{ ...saved, waitExpired: true as const }, saved]
  const reads: boolean[] = []
  let published: AgentPickerEntry[] = []
  const stop = observeAgentPickerAcquisition(
    'outlasting-listing',
    [codex],
    {
      catalog: async (_entry, waitForListing) => {
        reads.push(waitForListing)
        return waitForListing ? (waits.shift() ?? saved) : { ...saved, listingInProgress: true }
      },
      support: async () => undefined
    },
    { selected: () => undefined, publish: (entries) => (published = entries) }
  )
  try {
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reads).toEqual([false, true, true])
    expect(published[0]).toMatchObject({ catalogRead: 'settled', catalog: saved })
  } finally {
    stop()
  }
})

it('publishes every saved catalog while earlier refreshes are still pending', async () => {
  const fresh = Promise.withResolvers<AgentPickerEntry['catalog']>()
  const entries: AgentPickerEntry[] = [
    codex,
    { ...codex, agent: 'claude', label: 'Claude', rows: [{ agent: 'claude', kind: 'cli' }] },
    { ...codex, agent: 'gemini', label: 'Gemini', rows: [{ agent: 'gemini', kind: 'cli' }] }
  ]
  let published: AgentPickerEntry[] = []
  const stop = observeAgentPickerAcquisition(
    'independent-saved-catalogs',
    entries,
    {
      catalog: async (entry, waitForListing) =>
        waitForListing
          ? fresh.promise
          : {
              origin: 'probe',
              fetchedAt: 1,
              listingInProgress: true,
              models: [model(entry.agent)]
            },
      support: async () => undefined
    },
    { selected: () => 'codex', publish: (next) => (published = next) }
  )
  try {
    await expect
      .poll(() => published.map((entry) => entry.catalog))
      .toMatchObject([
        { models: [{ id: 'codex' }] },
        { models: [{ id: 'claude' }] },
        { models: [{ id: 'gemini' }] }
      ])
  } finally {
    stop()
    fresh.resolve({ origin: 'probe', fetchedAt: 2, models: [model('fresh')] })
  }
})

it('keeps an unflagged saved catalog provisional when its read fails', async () => {
  const fresh = Promise.withResolvers<AgentPickerEntry['catalog']>()
  let published: AgentPickerEntry[] = []
  const stop = observeAgentPickerAcquisition(
    'failed-unflagged-catalog',
    [{ ...codex, catalog: { origin: 'probe', fetchedAt: 1, models: [model('saved')] } }],
    { catalog: () => fresh.promise, support: async () => undefined },
    { selected: () => undefined, publish: (next) => (published = next) }
  )
  try {
    expect(published[0]).toMatchObject({
      catalogRead: 'pending',
      catalog: { models: [{ id: 'saved' }] }
    })
    fresh.reject(new Error('refresh failed'))
    await expect
      .poll(() => published[0])
      .toMatchObject({
        catalogRead: 'failed',
        catalog: { models: [{ id: 'saved' }] }
      })
  } finally {
    stop()
  }
})

it('keeps an open picker subscribed after usable progress until late enrichment arrives', async () => {
  const inventory = Promise.withResolvers<AgentPickerEntry['catalog']>()
  const enriched = Promise.withResolvers<AgentPickerEntry['catalog']>()
  let next = inventory.promise
  let published: AgentPickerEntry[] = []
  const close = observeAgentPickerAcquisition(
    'late-enrichment',
    [codex],
    {
      catalog: async (_entry, wait) =>
        wait ? next : { origin: 'unknown', listingInProgress: true },
      support: async () => undefined
    },
    {
      selected: () => 'codex',
      publish: (entries) => {
        published = entries
      }
    }
  )
  onTestFinished(close)
  await vi.waitFor(() => expect(published[0]?.catalog).toMatchObject({ listingInProgress: true }))
  next = enriched.promise
  inventory.resolve({ origin: 'probe', models: [model('listed')], listingInProgress: true })
  await vi.waitFor(() =>
    expect(published[0]?.catalog).toMatchObject({ models: [{ id: 'listed' }] })
  )
  expect(published[0]?.catalogRead).toBe('pending')
  enriched.resolve({
    origin: 'probe',
    models: [
      { ...model('listed'), defaultEffort: 'high', efforts: [{ value: 'high', label: 'High' }] }
    ]
  })
  await vi.waitFor(() =>
    expect(published[0]).toMatchObject({
      catalogRead: 'settled',
      catalog: { models: [{ id: 'listed', defaultEffort: 'high' }] }
    })
  )
})
