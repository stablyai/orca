import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AGENT_MODEL_CATALOG_FRESH_MS
} from '../../../../shared/agent-model-catalog-refresh-policy'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import {
  clearNativeChatModelEnrichmentForTests,
  ensureNativeChatModelEnrichment,
  readNativeChatEnrichedModels,
  subscribeNativeChatEnrichedModels
} from './native-chat-session-option-enrichment'

const initial: CatalogModel[] = [{ id: 'cursor-fast', label: 'Fast', options: [] }]
let now = 1_000

beforeEach(() => {
  now = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  clearNativeChatModelEnrichmentForTests()
})
afterEach(() => vi.restoreAllMocks())

it('refreshes an aged list once per host and publishes new model families and tiers', async () => {
  const discover = vi.fn<() => Promise<CatalogModel[]>>().mockResolvedValue(initial)
  const request = { agent: 'cursor' as const, hostKey: 'local', discover }
  const listener = vi.fn()
  subscribeNativeChatEnrichedModels('cursor', 'local', listener)
  ensureNativeChatModelEnrichment(request)
  await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())
  now += AGENT_MODEL_CATALOG_FRESH_MS - 1
  ensureNativeChatModelEnrichment(request)
  expect(discover).toHaveBeenCalledOnce()

  let finish: (models: CatalogModel[]) => void = () => {}
  discover.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  now += 1
  ensureNativeChatModelEnrichment(request)
  ensureNativeChatModelEnrichment(request)
  expect(discover).toHaveBeenCalledTimes(2)
  expect(readNativeChatEnrichedModels('cursor', 'local')?.map((m) => m.id)).toContain('cursor-fast')

  const discovered: CatalogModel[] = [
    { id: 'model-1', label: 'Model 1', options: [] },
    { id: 'model-2', label: 'Model 2', options: [] }
  ]
  finish(discovered)
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
  const models = readNativeChatEnrichedModels('cursor', 'local')!
  expect(models.map((m) => m.id)).toEqual(expect.arrayContaining(['model-1', 'model-2']))
})

it.each(['rejected', 'empty', 'null'] as const)(
  'retains the last success after a %s refresh and retries after the failure backoff',
  async (failure) => {
    const discover = vi.fn<() => Promise<CatalogModel[] | null>>().mockResolvedValue(initial)
    const request = { agent: 'cursor' as const, hostKey: 'local', discover }
    const listener = vi.fn()
    subscribeNativeChatEnrichedModels('cursor', 'local', listener)
    ensureNativeChatModelEnrichment(request)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())
    now += AGENT_MODEL_CATALOG_FRESH_MS
    if (failure === 'rejected') {
      discover.mockRejectedValue(new Error('offline'))
    } else {
      discover.mockResolvedValue(failure === 'empty' ? [] : null)
    }
    ensureNativeChatModelEnrichment(request)
    await Promise.resolve()
    await Promise.resolve()
    expect(readNativeChatEnrichedModels('cursor', 'local')?.map((m) => m.id)).toContain('cursor-fast')
    expect(listener).toHaveBeenCalledOnce()
    now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS - 1
    ensureNativeChatModelEnrichment(request)
    expect(discover).toHaveBeenCalledTimes(2)
    now += 1
    discover.mockResolvedValue([{ id: 'new-model', label: 'New model', options: [] }])
    ensureNativeChatModelEnrichment(request)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
    expect(discover).toHaveBeenCalledTimes(3)
    expect(readNativeChatEnrichedModels('cursor', 'local')?.map((m) => m.id)).toContain('new-model')
  }
)

it('retries a failed initial discovery without remounting or replacing another host list', async () => {
  const discover = vi.fn<() => Promise<CatalogModel[]>>().mockRejectedValue(new Error('offline'))
  const request = { agent: 'cursor' as const, hostKey: 'ssh:host', discover }
  ensureNativeChatModelEnrichment(request)
  await Promise.resolve()
  await Promise.resolve()
  const local = vi.fn().mockResolvedValue(initial)
  ensureNativeChatModelEnrichment({ ...request, hostKey: 'local', discover: local })
  await Promise.resolve()
  expect(readNativeChatEnrichedModels('cursor', 'ssh:host')).toBeNull()
  expect(readNativeChatEnrichedModels('cursor', 'local')?.map((m) => m.id)).toContain('cursor-fast')
  now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
  discover.mockResolvedValue([{ id: 'ssh-model', label: 'SSH model', options: [] }])
  ensureNativeChatModelEnrichment(request)
  ensureNativeChatModelEnrichment({ ...request, hostKey: 'local', discover: local })
  await Promise.resolve()
  expect(discover).toHaveBeenCalledTimes(2)
  expect(local).toHaveBeenCalledOnce()
  expect(readNativeChatEnrichedModels('cursor', 'local')?.map((m) => m.id)).toContain('cursor-fast')
  expect(readNativeChatEnrichedModels('cursor', 'ssh:host')?.map(({ id }) => id)).toEqual(
    expect.arrayContaining(['ssh-model'])
  )
})
