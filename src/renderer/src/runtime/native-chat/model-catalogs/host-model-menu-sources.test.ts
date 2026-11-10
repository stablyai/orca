import { beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ structured: vi.fn() }))
vi.mock('../requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: calls.structured
}))
vi.mock('../host-capabilities/structured-agent-session-host-capability', () => ({
  structuredAgentSessionHostKey: () => 'local'
}))
import { hostModelMenuCatalog } from './host-model-menu-catalog'
import {
  forgetHostModelCatalogSnapshots,
  hostModelCatalogSnapshotAgents,
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from './host-model-catalog-snapshots'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'

const target = { kind: 'local' } as const
const positive = (id: string): AgentSessionModelCatalogResult => ({
  origin: 'probe',
  fetchedAt: 1,
  modelsDifferByWorkspace: true,
  models: [{ id, label: id, isDefault: true, efforts: [] }]
})
beforeEach(() => {
  resetHostModelCatalogSnapshotsForTests()
  calls.structured.mockReset()
})

it.each(['structured-first', 'cli-first'])(
  'retains source-scoped negative evidence through handoff and failed refresh: %s',
  async (order) => {
    const acp = Promise.withResolvers<AgentSessionModelCatalogResult>()
    const cli = Promise.withResolvers<AgentSessionModelCatalogResult>()
    calls.structured.mockReturnValueOnce(acp.promise)
    const request = vi
      .fn<() => Promise<AgentSessionModelCatalogResult>>()
      .mockReturnValueOnce(cli.promise)
    const base = { target, agent: 'antigravity' }
    const chat = hostModelMenuCatalog(base),
      terminal = hostModelMenuCatalog({ ...base, sourceKey: 'cli', request })
    const stopChat = chat.subscribe(() => {}),
      stopCli = terminal.subscribe(() => {})
    const chatRead = chat.read(false, undefined, new AbortController().signal),
      cliRead = terminal.read(false, undefined, new AbortController().signal)
    if (order === 'structured-first') {
      acp.resolve(positive('base'))
      await chatRead
      expect(terminal.snapshot.pending).toBe(true)
      cli.resolve(positive('variant'))
      await cliRead
    } else {
      cli.resolve(positive('variant'))
      await cliRead
      expect(hostModelCatalogSnapshotAgents(target)).toEqual([])
      expect(chat.snapshot.pending).toBe(true)
      acp.resolve(positive('base'))
      await chatRead
    }
    expect(chat.snapshot.answer).toMatchObject({ models: [{ id: 'base' }] })
    expect(terminal.snapshot.answer).toMatchObject({ models: [{ id: 'variant' }] })
    stopCli()
    for (const negative of [
      { origin: 'unknown' },
      { origin: 'probe', fetchedAt: 2, models: [] }
    ] satisfies AgentSessionModelCatalogResult[]) {
      recordHostModelCatalogSnapshot(target, 'antigravity', null, negative, 'cli')
      recordHostModelCatalogSnapshot(target, 'antigravity', 'id:y', positive('sibling'), 'cli')
      const successor = hostModelMenuCatalog({ ...base, sourceKey: 'cli', request })
      const detach = successor.subscribe(() => {})
      request.mockRejectedValueOnce(new Error('offline'))
      expect(await successor.read(false, undefined, new AbortController().signal)).toEqual(negative)
      expect(
        readHostModelCatalogSnapshot(
          target,
          'antigravity',
          { newLaunch: true, seedsModel: true, worktree: 'id:x' },
          'cli'
        )
      ).toBeUndefined()
      recordHostModelCatalogSnapshot(target, 'antigravity', null, positive('base-new'))
      expect(successor.snapshot.answer).toEqual(negative)
      expect(
        readHostModelCatalogSnapshot(target, 'antigravity', {
          newLaunch: true,
          seedsModel: true,
          worktree: null
        })
      ).toMatchObject({ models: [{ id: 'base-new' }] })
      recordHostModelCatalogSnapshot(target, 'antigravity', 'id:x', negative, 'cli')
      const scoped = hostModelMenuCatalog({ ...base, worktree: 'id:x', sourceKey: 'cli', request })
      const closeScoped = scoped.subscribe(() => {})
      closeScoped()
      const reopened = hostModelMenuCatalog({
        ...base,
        worktree: 'id:x',
        sourceKey: 'cli',
        request
      })
      const closeReopened = reopened.subscribe(() => {})
      request.mockRejectedValueOnce(new Error('reopen offline'))
      expect(await reopened.read(false, undefined, new AbortController().signal)).toEqual(negative)
      closeReopened()
      detach()
    }
    const late = Promise.withResolvers<AgentSessionModelCatalogResult>()
    request.mockReturnValueOnce(late.promise)
    const owner = hostModelMenuCatalog({ ...base, sourceKey: 'cli', request })
    const detach = owner.subscribe(() => {})
    const reading = owner.read(false, undefined, new AbortController().signal)
    await Promise.resolve()
    forgetHostModelCatalogSnapshots(target)
    late.resolve(positive('stale'))
    await reading
    expect(owner.snapshot.answer).toBeUndefined()
    expect(chat.snapshot.answer).toBeUndefined()
    request.mockResolvedValueOnce(positive('replacement'))
    expect(await owner.read(false, undefined, new AbortController().signal)).toMatchObject({
      models: [{ id: 'replacement' }]
    })
    detach()
    stopChat()
  }
)
