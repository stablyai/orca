import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('../host-capabilities/structured-agent-session-host-capability', () => ({
  structuredAgentSessionHostKey: (target: { kind: string; environmentId?: string }) =>
    target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}))
import { hostModelMenuCatalog } from './host-model-menu-catalog'
import {
  forgetHostModelCatalogSnapshots,
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from './host-model-catalog-snapshots'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
const target = { kind: 'local' } as const
const catalog = (id: string): Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }> => ({
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: false,
  models: [{ id, label: id, isDefault: false, efforts: [] }]
})
beforeEach(() => {
  mocks.call.mockReset()
  resetHostModelCatalogSnapshotsForTests()
})

import { modelMenuOptions } from '../../../../../shared/agent-session/options/model-menu-options'
import { getAgentSessionOptionLaunchCatalog } from '../../../../../shared/agent-session/options/agent-session-option-catalog'
const projection = (answer: AgentSessionModelCatalogResult | undefined) =>
  modelMenuOptions(answer, {
    agent: 'codex',
    surface: 'chat',
    newLaunch: true,
    seedsModel: true,
    coherentCatalog: true,
    seed: getAgentSessionOptionLaunchCatalog('codex')!
  })

it('preserves scoped retirement across owner handoff and rejected reopen without changing another workspace', async () => {
  for (const fallback of ['account', 'workspace'] as const) {
    for (const retired of [
      { origin: 'probe', fetchedAt: 2, models: [] },
      { origin: 'unknown' }
    ] satisfies AgentSessionModelCatalogResult[]) {
      resetHostModelCatalogSnapshotsForTests()
      recordHostModelCatalogSnapshot(
        target,
        'codex',
        fallback === 'account' ? null : 'id:seed',
        catalog('old-only')
      )
      const scope = { target, agent: 'codex', worktree: 'id:a' }
      const a = hostModelMenuCatalog(scope)
      const b = hostModelMenuCatalog({ target, agent: 'codex', worktree: 'id:b' })
      const onA = vi.fn(),
        onB = vi.fn()
      const stopA = a.subscribe(onA),
        stopB = b.subscribe(onB)
      expect(a.snapshot.answer).toMatchObject({ models: [{ id: 'old-only' }] })
      recordHostModelCatalogSnapshot(target, 'codex', 'id:b', catalog('other'))
      onA.mockClear()
      onB.mockClear()
      recordHostModelCatalogSnapshot(target, 'codex', 'id:a', retired)
      expect(a.snapshot.answer).toEqual(retired)
      expect(projection(a.snapshot.answer).status).toBe(
        retired.origin === 'unknown' ? 'builtin' : 'listed'
      )
      if (retired.origin !== 'unknown') {
        expect(projection(a.snapshot.answer).rows).toEqual([])
      }
      expect(onA).toHaveBeenCalledTimes(1)
      expect(onB).not.toHaveBeenCalled()
      stopA()
      const successor = hostModelMenuCatalog(scope)
      const stopSuccessor = successor.subscribe(() => {})
      expect(successor).not.toBe(a)
      expect(successor.snapshot.answer).toEqual(retired)
      mocks.call.mockRejectedValueOnce(new Error('reopen offline'))
      await successor.read(undefined, new AbortController().signal)
      expect(successor.snapshot.answer).toEqual(retired)
      recordHostModelCatalogSnapshot(target, 'codex', 'id:b', catalog('other-new'))
      expect(successor.snapshot.answer).toEqual(retired)
      expect(b.snapshot.answer).toMatchObject({ models: [{ id: 'other-new' }] })
      if (fallback === 'workspace') {
        recordHostModelCatalogSnapshot(target, 'codex', 'id:seed', { origin: 'unknown' })
        expect(
          readHostModelCatalogSnapshot(target, 'codex', {
            newLaunch: true,
            seedsModel: true,
            worktree: 'id:new'
          })
        ).toMatchObject({ models: [{ id: 'other-new' }] })
      }
      recordHostModelCatalogSnapshot(target, 'codex', 'id:a', catalog('replacement'))
      expect(successor.snapshot.answer).toMatchObject({ models: [{ id: 'replacement' }] })
      stopSuccessor()
      stopB()
    }
  }
})

it.each([
  { origin: 'probe', fetchedAt: 2, models: [] },
  { origin: 'unknown' }
] satisfies AgentSessionModelCatalogResult[])(
  'retains account evidence $origin through handoff, pending failure and sibling publications',
  async (answer) => {
    recordHostModelCatalogSnapshot(target, 'codex', null, catalog('old-only'))
    recordHostModelCatalogSnapshot(target, 'codex', 'id:old', catalog('old-workspace'))
    const scope = { target, agent: 'codex' }
    const owner = hostModelMenuCatalog(scope)
    const stop = owner.subscribe(() => {})
    mocks.call.mockResolvedValueOnce(answer)
    expect(await owner.read(undefined, new AbortController().signal)).toEqual(answer)
    expect(owner.snapshot.answer).toEqual(answer)
    const read = () =>
      readHostModelCatalogSnapshot(target, 'codex', {
        worktree: null,
        newLaunch: true,
        seedsModel: false
      })
    expect(read()).toEqual(answer)
    expect(projection(read()).status).toBe(answer.origin === 'unknown' ? 'builtin' : 'listed')
    if (answer.origin !== 'unknown') {
      expect(projection(read()).rows).toEqual([])
    }
    stop()
    const successor = hostModelMenuCatalog(scope)
    const detach = successor.subscribe(() => {})
    expect(successor).not.toBe(owner)
    mocks.call.mockRejectedValueOnce(new Error('reopen offline'))
    expect(await successor.read(undefined, new AbortController().signal)).toEqual(answer)
    recordHostModelCatalogSnapshot(target, 'codex', 'id:sibling', catalog('sibling'))
    expect(successor.snapshot.answer).toEqual(answer)
    expect(
      readHostModelCatalogSnapshot(target, 'codex', {
        worktree: 'id:old',
        newLaunch: true,
        seedsModel: false
      })
    ).toBeUndefined()
    mocks.call
      .mockResolvedValueOnce({ origin: 'unknown', listingInProgress: true })
      .mockRejectedValueOnce(new Error('refresh offline'))
    expect(await successor.read(undefined, new AbortController().signal)).toEqual(answer)
    expect(read()).toEqual(answer)
    mocks.call.mockResolvedValueOnce(catalog('replacement'))
    await successor.read(undefined, new AbortController().signal)
    expect(successor.snapshot.answer).toMatchObject({ models: [{ id: 'replacement' }] })
    forgetHostModelCatalogSnapshots(target)
    expect(successor.snapshot.answer).toBeUndefined()
    expect(read()).toBeUndefined()
    detach()
  }
)
