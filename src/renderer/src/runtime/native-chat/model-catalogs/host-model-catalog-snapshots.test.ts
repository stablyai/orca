import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('../requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))

import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import {
  readHostModelCatalogSnapshot,
  loadHostModelCatalogSnapshot,
  forgetHostModelCatalogSnapshots,
  preloadHostModelCatalogSnapshots,
  resetHostModelCatalogSnapshotsForTests
} from './host-model-catalog-snapshots'

const LOCAL = { kind: 'local' } as const
const NEW_CHAT = { newLaunch: true, worktree: 'wt-1', seedsModel: false }

function list(listingNamesConfiguredModel: boolean): AgentSessionModelCatalogResult {
  return {
    origin: 'probe',
    models: [{ id: 'm-1', label: 'M 1', isDefault: true, efforts: [] }],
    fetchedAt: 1,
    listingNamesConfiguredModel
  }
}

describe('host model catalog snapshots', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  it('withholds a direct reply invalidated by an account or host change', async () => {
    let finish: ((value: AgentSessionModelCatalogResult) => void) | undefined
    mocks.call.mockImplementationOnce(
      () =>
        new Promise<AgentSessionModelCatalogResult>((resolve) => {
          finish = resolve
        })
    )
    const pending = loadHostModelCatalogSnapshot(LOCAL, 'codex')
    forgetHostModelCatalogSnapshots(LOCAL)
    finish?.(list(false))
    expect(await pending).toBeUndefined()
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', NEW_CHAT)).toBeUndefined()
  })

  it('awaits a listing only after the host reports it in progress, and records the settled answer', async () => {
    mocks.call
      .mockResolvedValueOnce({ origin: 'unknown', listingInProgress: true })
      .mockResolvedValueOnce(list(false))
    await preloadHostModelCatalogSnapshots(LOCAL, ['codex'], { awaitListing: true })
    expect(mocks.call.mock.calls).toEqual([
      [LOCAL, 'agentSession.modelCatalog', { agent: 'codex' }],
      [LOCAL, 'agentSession.modelCatalog', { agent: 'codex', waitForListing: true }]
    ])
    expect(readHostModelCatalogSnapshot(LOCAL, 'codex', { ...NEW_CHAT, newLaunch: false })).toEqual(
      list(false)
    )
  })

  it('does not send the listing wait field to an older host or with a saved-only read', async () => {
    mocks.call.mockResolvedValue(list(false))
    await preloadHostModelCatalogSnapshots(LOCAL, ['codex'], { awaitListing: true })
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(LOCAL, 'agentSession.modelCatalog', {
      agent: 'codex'
    })
    mocks.call.mockClear()
    mocks.call.mockResolvedValue({ origin: 'unknown', listingInProgress: true })
    await preloadHostModelCatalogSnapshots(LOCAL, ['codex'], {
      savedOnly: true,
      awaitListing: true
    })
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(LOCAL, 'agentSession.modelCatalog', {
      agent: 'codex',
      savedOnly: true
    })
  })
})
