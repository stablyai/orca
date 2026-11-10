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
      await successor.read(false, undefined, new AbortController().signal)
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
    expect(await owner.read(false, undefined, new AbortController().signal)).toEqual(answer)
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
    expect(await successor.read(false, undefined, new AbortController().signal)).toEqual(answer)
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
    expect(await successor.read(false, undefined, new AbortController().signal)).toEqual(answer)
    expect(read()).toEqual(answer)
    mocks.call.mockResolvedValueOnce(catalog('replacement'))
    await successor.read(false, undefined, new AbortController().signal)
    expect(successor.snapshot.answer).toMatchObject({ models: [{ id: 'replacement' }] })
    forgetHostModelCatalogSnapshots(target)
    expect(successor.snapshot.answer).toBeUndefined()
    expect(read()).toBeUndefined()
    detach()
  }
)

it.each(['codex', 'claude'])(
  'keeps %s account membership while projecting only proven launch defaults',
  async (agent) => {
    const answer: AgentSessionModelCatalogResult = {
      origin: 'probe',
      fetchedAt: 3,
      modelsDifferByWorkspace: true,
      listingNamesConfiguredModel: true,
      models: [
        {
          id: 'gpt-6.1-sol',
          label: 'GPT-6.1 Sol',
          isDefault: true,
          efforts: [
            { value: 'high', label: 'High' },
            { value: 'ultra', label: 'Ultra' }
          ],
          defaultEffort: 'high'
        }
      ]
    }
    const expected = {
      ...answer,
      listingNamesConfiguredModel: false,
      models: [{ ...answer.models[0], isDefault: false }]
    }
    const scope = { target, agent }
    const owner = hostModelMenuCatalog(scope)
    const settled: unknown[] = []
    const stop = owner.subscribe(() => {
      if (!owner.snapshot.pending) {
        settled.push(owner.snapshot.answer)
      }
    })
    mocks.call.mockResolvedValueOnce(answer)
    expect(await owner.read(false, undefined, new AbortController().signal)).toEqual(expected)
    expect(owner.snapshot.answer).toEqual(expected)
    expect(settled).toEqual([expected])
    const read = (worktree: string | null | undefined) =>
      readHostModelCatalogSnapshot(target, agent, {
        worktree,
        newLaunch: true,
        seedsModel: false
      })
    expect(read(null)).toEqual(expected)
    expect(projection(owner.snapshot.answer).rows).toMatchObject([
      { id: 'gpt-6.1-sol', efforts: [{ value: 'high' }, { value: 'ultra' }] }
    ])
    expect(read('id:new')).toBeUndefined()
    expect(read(undefined)).toBeUndefined()
    for (const worktree of ['id:sibling', '']) {
      recordHostModelCatalogSnapshot(target, agent, worktree, {
        ...catalog('workspace'),
        modelsDifferByWorkspace: true
      })
      expect(owner.snapshot.answer).toEqual(expected)
      expect(read(worktree)).toMatchObject({ models: [{ id: 'workspace' }] })
    }
    expect(read(undefined)).toMatchObject({ models: [{ id: 'workspace' }] })
    stop()
    const successor = hostModelMenuCatalog(scope)
    const detach = successor.subscribe(() => {})
    mocks.call.mockRejectedValueOnce(new Error('reopen offline'))
    expect(await successor.read(false, undefined, new AbortController().signal)).toEqual(expected)
    for (const replacement of [
      { origin: 'probe', fetchedAt: 4, models: [] },
      { origin: 'unknown' }
    ] satisfies AgentSessionModelCatalogResult[]) {
      mocks.call.mockResolvedValueOnce(replacement)
      expect(await successor.read(false, undefined, new AbortController().signal)).toEqual(
        replacement
      )
      expect(successor.snapshot.answer).toEqual(replacement)
    }
    const universal = { ...answer, defaultHoldsInEveryWorkspace: true as const }
    mocks.call.mockResolvedValueOnce(universal)
    expect(await successor.read(false, undefined, new AbortController().signal)).toEqual(universal)
    forgetHostModelCatalogSnapshots(target)
    expect(read(null)).toBeUndefined()
    recordHostModelCatalogSnapshot(target, agent, 'id:only', answer)
    expect(read(null)).toBeUndefined()
    expect(read('id:only')).toEqual(answer)
    detach()
  }
)

it('fences late negative account and workspace replies after invalidation', async () => {
  for (const worktree of [undefined, 'id:late']) {
    for (const answer of [
      { origin: 'probe', fetchedAt: 2, models: [] },
      { origin: 'unknown' }
    ] satisfies AgentSessionModelCatalogResult[]) {
      const pending = Promise.withResolvers<AgentSessionModelCatalogResult>()
      mocks.call.mockReturnValueOnce(pending.promise)
      const scope = { target, agent: 'codex', worktree }
      const owner = hostModelMenuCatalog(scope)
      const stop = owner.subscribe(() => {})
      const reading = owner.read(false, undefined, new AbortController().signal)
      await vi.waitFor(() =>
        expect(mocks.call.mock.calls.at(-1)?.[2]).toEqual({
          agent: 'codex',
          ...(worktree ? { worktree } : {})
        })
      )
      forgetHostModelCatalogSnapshots(target)
      pending.resolve(answer)
      await reading
      expect(owner.snapshot.answer).toBeUndefined()
      expect(
        readHostModelCatalogSnapshot(target, 'codex', {
          newLaunch: true,
          seedsModel: true,
          worktree: worktree ?? null
        })
      ).toBeUndefined()
      stop()
      mocks.call.mockReset()
    }
  }
})
