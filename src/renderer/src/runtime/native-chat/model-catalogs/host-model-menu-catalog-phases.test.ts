import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import { hostModelMenuCatalog } from './host-model-menu-catalog'
import { resetHostModelCatalogSnapshotsForTests } from './host-model-catalog-snapshots'

const target = { kind: 'local' } as const
const listing = { origin: 'unknown', listingInProgress: true } as const
const expired = { ...listing, waitExpired: true } as const
const models = (id: string): AgentSessionModelCatalogResult => ({
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: false,
  models: [{ id, label: id, isDefault: false, efforts: [] }]
})
beforeEach(() => resetHostModelCatalogSnapshotsForTests())

it('keeps the first timed-out list through failure without authorizing another refresh, then reopens', async () => {
  const request = vi
    .fn<(wait: boolean) => Promise<AgentSessionModelCatalogResult>>()
    .mockResolvedValueOnce(listing)
    .mockResolvedValueOnce({ ...models('gpt-6.1-sol'), listingInProgress: true, waitExpired: true })
    .mockRejectedValue(new Error('host offline'))
  const scope = { target, agent: 'codex', worktree: 'id:expired-first-list', request }
  const owner = hostModelMenuCatalog(scope)
  const stop = owner.subscribe(() => {})
  try {
    await owner.read(false, false)
    let answer = await owner.read(false, true)
    // One plain read, one genuinely expired wait, and one failed successor exhaust demand.
    for (let attempts = 0; answer?.waitExpired && attempts < 2; attempts++) {
      answer = await owner.read(false, true)
    }
    expect(request.mock.calls).toEqual([[false], [true], [true]])
    expect(answer).toMatchObject({ models: [{ id: 'gpt-6.1-sol' }] })
    expect(answer?.waitExpired).toBeUndefined()
    expect(owner.snapshot.pending).toBe(false)
  } finally {
    stop()
  }
  request.mockResolvedValueOnce(models('reconnected'))
  const successor = hostModelMenuCatalog(scope)
  const stopSuccessor = successor.subscribe(() => {})
  try {
    expect(await successor.read()).toMatchObject({ models: [{ id: 'reconnected' }] })
    expect(request.mock.calls).toEqual([[false], [true], [true], [false]])
  } finally {
    stopSuccessor()
  }
})

it('gives a waiting caller a waited result and follows expired waits only while the menu stays open', async () => {
  const plain = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const wait = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const request = vi
    .fn<(wait: boolean) => Promise<AgentSessionModelCatalogResult>>()
    .mockReturnValueOnce(plain.promise)
    .mockReturnValueOnce(wait.promise)
    .mockResolvedValueOnce(models('finally-listed'))
  const owner = hostModelMenuCatalog({ target, agent: 'codex', worktree: 'id:phases', request })
  const stop = owner.subscribe(() => {})
  const open = new AbortController()
  try {
    const plainRead = owner.read(false, false)
    const waitingRead = owner.read(false, true)
    const automaticRead = owner.read(false, undefined, open.signal)
    plain.resolve(listing)
    expect(await plainRead).toMatchObject(listing)
    await expect.poll(() => request.mock.calls).toEqual([[false], [true]])
    wait.resolve(expired)
    expect(await waitingRead).toMatchObject({ listingInProgress: true, waitExpired: true })
    expect(await automaticRead).toMatchObject({ models: [{ id: 'finally-listed' }] })
    expect(owner.snapshot.answer).toMatchObject({ models: [{ id: 'finally-listed' }] })
    expect(request.mock.calls).toEqual([[false], [true], [true]])
  } finally {
    open.abort()
    stop()
    plain.resolve(listing)
    wait.resolve(expired)
  }

  const closingWait = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const closingRequest = vi
    .fn<(wait: boolean) => Promise<AgentSessionModelCatalogResult>>()
    .mockResolvedValueOnce(listing)
    .mockReturnValueOnce(closingWait.promise)
    .mockResolvedValue(models('must-not-request'))
  const closing = hostModelMenuCatalog({ target, agent: 'claude', request: closingRequest })
  const stopClosing = closing.subscribe(() => {})
  const closed = new AbortController()
  try {
    const reading = closing.read(false, undefined, closed.signal)
    await expect.poll(() => closingRequest.mock.calls).toEqual([[false], [true]])
    closed.abort()
    closingWait.resolve(expired)
    await reading
    expect(closingRequest.mock.calls).toEqual([[false], [true]])
  } finally {
    closed.abort()
    stopClosing()
    closingWait.resolve(expired)
  }
})
