import { expect, it, vi } from 'vitest'
import { readModelMenuCatalog } from './model-menu-catalog-read'
import { recordHostModelCatalogSnapshot } from './host-model-catalog-snapshots'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: transport.call
}))

it('returns the current plain host evidence during a wait without borrowing bootstrap rows', async () => {
  const scope = {
    target: { kind: 'local' } as const,
    agent: 'codex',
    worktree: 'id:independent-phases'
  }
  recordHostModelCatalogSnapshot(scope.target, 'codex', scope.worktree, {
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'old-only', label: 'Old', isDefault: false, efforts: [] }]
  })
  const waiting = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const started = Promise.withResolvers<void>()
  transport.call.mockImplementation((_target, _method, params) => {
    if (params.waitForListing) {
      started.resolve()
      return waiting.promise
    }
    return {
      origin: 'probe',
      fetchedAt: 2,
      listingInProgress: true,
      models: [{ id: 'new-only', label: 'New', isDefault: false, efforts: [] }]
    }
  })
  const signal = new AbortController().signal
  const waiter = readModelMenuCatalog(scope, true, signal)
  try {
    await started.promise
    const plain = await readModelMenuCatalog(scope, false, signal)
    expect(plain).toEqual({
      origin: 'probe',
      fetchedAt: 2,
      listingInProgress: true,
      models: [{ id: 'new-only', label: 'New', isDefault: false, efforts: [] }]
    })
    transport.call.mockResolvedValueOnce({ origin: 'unknown', listingInProgress: true })
    expect(await readModelMenuCatalog(scope, false, signal)).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    waiting.resolve({
      origin: 'probe',
      fetchedAt: 3,
      models: [{ id: 'finished-only', label: 'Finished', isDefault: false, efforts: [] }]
    })
    expect(await waiter).toEqual({
      origin: 'probe',
      fetchedAt: 3,
      models: [{ id: 'finished-only', label: 'Finished', isDefault: false, efforts: [] }]
    })
  } finally {
    waiting.resolve({ origin: 'unknown' })
  }
})
