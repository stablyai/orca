import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hostModelMenuCatalog, ModelMenuContextUnresolvedError } from './host-model-menu-catalog'
import {
  resetHostModelCatalogSnapshotsForTests,
  subscribeHostModelCatalogSnapshot,
  forgetHostModelCatalogSnapshots
} from './host-model-catalog-snapshots'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'

const target = { kind: 'local' } as const
const answer = (id: string): AgentSessionModelCatalogResult => ({
  origin: 'probe',
  fetchedAt: 0,
  modelsDifferByWorkspace: true,
  listingNamesConfiguredModel: false,
  models: [{ id, label: id, isDefault: false, efforts: [] }]
})
let now = 1
beforeEach(() => {
  resetHostModelCatalogSnapshotsForTests()
  now = 1
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => vi.restoreAllMocks())

it.each([
  answer('account-model'),
  { origin: 'probe' as const, fetchedAt: 0, models: [] },
  { origin: 'unknown' } as const
])(
  'revalidates on demand after ten minutes, retaining positive or negative evidence across failure and owner handoff',
  async (held) => {
    const request = vi
      .fn<() => Promise<AgentSessionModelCatalogResult | undefined>>()
      .mockResolvedValueOnce(held)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(answer('new-model'))
      .mockResolvedValueOnce(answer('new-model'))
    const scope = {
      target,
      agent: 'antigravity',
      worktree: 'id:freshness',
      sourceKey: 'cli',
      request
    }
    let owner = hostModelMenuCatalog(scope)
    let stop = owner.subscribe(() => {})
    await owner.read(true)
    stop()
    now = 600000
    owner = hostModelMenuCatalog(scope)
    stop = owner.subscribe(() => {})
    expect(await owner.read(true)).toEqual(held)
    expect(request).toHaveBeenCalledTimes(1)
    now = 600001
    const refreshing = owner.read(true)
    expect(owner.snapshot.answer).toEqual(held)
    await refreshing
    expect(owner.snapshot.answer).toEqual(held)
    await owner.read(true)
    expect(request).toHaveBeenCalledTimes(2)
    now = 1200001
    // Time alone does no work.
    expect(request).toHaveBeenCalledTimes(2)
    expect(await owner.read(true)).toEqual(answer('new-model'))
    const notices = vi.fn()
    const detach = subscribeHostModelCatalogSnapshot(target, 'antigravity', notices, 'cli')
    now = 1800001
    await owner.read(true)
    expect(notices).not.toHaveBeenCalled()
    detach()
    stop()
  }
)

it('does not suppress a prompt retry after an unresolved WSL context', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new ModelMenuContextUnresolvedError())
    .mockResolvedValueOnce(answer('ubuntu-model'))
  const scope = { target, agent: 'antigravity', sourceKey: 'cli-unresolved', request }
  const owner = hostModelMenuCatalog(scope)
  const stop = owner.subscribe(() => {})
  await owner.read(true)
  expect(await owner.read(true)).toEqual(answer('ubuntu-model'))
  expect(request).toHaveBeenCalledTimes(2)
  stop()
})

it('runtime invalidation bypasses reuse and fences an old native response', async () => {
  const old = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const request = vi
    .fn()
    .mockResolvedValueOnce(answer('native-model'))
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(answer('ubuntu-model'))
  const scope = { target, agent: 'antigravity', sourceKey: 'cli-switch', request }
  const owner = hostModelMenuCatalog(scope)
  const stop = owner.subscribe(() => {})
  await owner.read(true)
  const nativePending = owner.read()
  await Promise.resolve()
  // The real settings subscription drives this same host/agent invalidation on shell changes.
  forgetHostModelCatalogSnapshots(target)
  now = 2
  expect(await owner.read(true)).toEqual(answer('ubuntu-model'))
  old.resolve(answer('native-late'))
  await nativePending
  expect(owner.snapshot.answer).toEqual(answer('ubuntu-model'))
  expect(request).toHaveBeenCalledTimes(3)
  stop()
})
