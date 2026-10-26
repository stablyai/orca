import { subscribeAgentStatusState } from './agent-status'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createAppState } from './index'
import type { AgentStatusReadState, AgentStatusTransition } from './agent-status-observers'
import type { AppState } from './types'
import { getAgentStatusOwner } from './agent-status-commit'
import { createAutomationDispatchCompletion } from '@/hooks/automation-dispatch-completion'
import { makeRun } from '@/components/automations/automations-page-fixtures'
import { makeWorktree } from './slices/worktrees-slice-test-fixtures'

type AgentStatusReadProbe = AgentStatusReadState & {
  readonly [key: symbol]: unknown
  readonly hidden?: string
  readonly transient?: string
  readonly __proto__?: object
}

type AgentStatusAppProbe = { [Key in keyof AppState]: AppState[Key] } & Readonly<
  Record<PropertyKey, unknown>
>

const facet = { state: 'working', progress: 42, observedAt: 1000 } as const
afterEach(() => vi.useRealTimers())

describe('canonical status writers and their real consumers', () => {
  it.each([10, 100])(
    'folds %i real status updates with linear live-record reads and keyed isolation',
    (count) => {
      vi.useFakeTimers()
      const store = createStore(createAppState)
      const status = getAgentStatusOwner(store)
      const keys = Array.from({ length: count }, (_, n) => `tab-${n}:1`)
      const publish = (time: number) =>
        store.getState().setAgentStatuses(
          keys.map((paneKey) => ({
            kind: 'status' as const,
            paneKey,
            payload: { state: 'working' as const, prompt: 'task' },
            timing: { updatedAt: time }
          }))
        )
      publish(100)
      const initial = status.getSnapshot()
      let rowReads = 0
      for (const key of keys) {
        const value = initial[key]
        Object.defineProperty(initial, key, {
          enumerable: true,
          configurable: true,
          get() {
            rowReads++
            return value
          }
        })
      }
      publish(101)
      expect(rowReads).toBeLessThanOrEqual(8 * count)
      const app = vi.fn()
      const changed = vi.fn()
      const unrelated = vi.fn()
      const aggregate = vi.fn()
      store.subscribe(app)
      status.subscribeEntry(keys[0], changed)
      status.subscribeEntry(keys[1], unrelated)
      status.subscribeAggregate(aggregate)
      const snapshot = status.getSnapshot()
      expect(store.getState().setAgentProgramStatus(keys[0], facet)).toBe(true)
      expect(status.getEntry(keys[0])?.programStatus).toEqual(facet)
      expect(status.getEntry(keys[1])).toBe(snapshot[keys[1]])
      expect(changed).toHaveBeenCalledTimes(1)
      expect(unrelated).not.toHaveBeenCalled()
      expect(aggregate).toHaveBeenCalledTimes(1)
      expect(app).not.toHaveBeenCalled()
      expect(store.getState().setAgentProgramStatus(keys[0], facet)).toBe(false)
      expect(changed).toHaveBeenCalledTimes(1)
      expect(store.getState()).not.toHaveProperty('agentStatusByPaneKey')
      store.getState().setAgentProgramStatus(keys[0], null)
      store.getState().removeAgentStatus(keys[0])
      expect(status.getEntry(keys[0])).toBeUndefined()
    }
  )

  it.each([10, 100])(
    'materializes one app root and staged view for %i real companion-changing rows',
    (count) => {
      vi.useFakeTimers()
      for (const paired of [false, true]) {
        const store = createStore(createAppState)
        const owner = getAgentStatusOwner(store)
        const previous = store.getState()
        const copies = vi.fn(() => null)
        Object.defineProperty(previous, 'activeWorktreeId', {
          enumerable: true,
          configurable: true,
          get: copies
        })
        const pairs: AgentStatusTransition[] = []
        if (paired) {
          owner.subscribeTransitions((pair) => pairs.push(pair))
        }
        const app = vi.fn()
        store.subscribe(app)
        const roots = new Set<AppState>()
        const views = new Set<AgentStatusReadState>()
        const fold = (abort: boolean): void =>
          store.getState().transactAgentStatuses((transaction) => {
            const view = transaction.getState()
            views.add(view)
            for (let n = 0; n < count; n++) {
              expect(
                transaction.apply({
                  kind: 'status',
                  paneKey: `view-${n}:1`,
                  payload: { state: 'working', prompt: 'task' },
                  timing: { updatedAt: 100 }
                })
              ).toBe(true)
              expect(transaction.getState().agentStatusEpoch).toBe(n + 1)
              expect(view.agentStatusEpoch).toBe(n + 1)
              expect(view.agentStatusByPaneKey[`view-${n}:1`]?.state).toBe('working')
              expect(store.getState()).toBe(previous)
              roots.add(owner.getAppState())
              views.add(transaction.getState())
            }
            expect(
              transaction.apply({ kind: 'programStatus', paneKey: 'absent:1', programStatus: null })
            ).toBe(false)
            if (abort) {
              throw new Error('abort real fold')
            }
          })
        expect(() => fold(true)).toThrow('abort real fold')
        expect(store.getState()).toBe(previous)
        expect(owner.getSnapshot()).toEqual({})
        expect(app).not.toHaveBeenCalled()
        expect(pairs).toEqual([])
        expect(roots.size).toBe(1)
        expect(views.size).toBe(1)
        copies.mockClear()
        roots.clear()
        views.clear()
        fold(false)
        expect(roots.size).toBe(1)
        expect(views.size).toBe(1)
        expect(copies).toHaveBeenCalledTimes(1)
        expect(app).toHaveBeenCalledTimes(1)
        expect(store.getState()).toBe([...roots][0])
        expect(store.getState().agentStatusEpoch).toBe(count)
        expect(Object.keys(owner.getSnapshot())).toHaveLength(count)
        if (paired) {
          expect(pairs).toHaveLength(1)
          expect(pairs[0].previous.agentStatusEpoch).toBe(0)
          expect(pairs[0].previous.agentStatusByPaneKey).toEqual({})
          expect(pairs[0].next.agentStatusEpoch).toBe(count)
          expect(Object.keys(pairs[0].next.agentStatusByPaneKey)).toHaveLength(count)
          store.setState({ agentStatusEpoch: count + 1 })
          expect(pairs[0].next.agentStatusEpoch).toBe(count)
        }
      }
    }
  )

  it('invalidates current consumers coherently across status-only and recursive companion writes', () => {
    vi.useFakeTimers()
    const store = createStore(createAppState)
    const status = getAgentStatusOwner(store)
    const point = 'consumer:1'
    const seen: { state: string | undefined; epoch: number }[] = []
    const unsubscribe = subscribeAgentStatusState((next) => {
      expect(next).toBe(status.getState())
      seen.push({ state: next.agentStatusByPaneKey[point]?.state, epoch: next.agentStatusEpoch })
      if (next.agentStatusEpoch === 1) {
        store.setState({ agentStatusEpoch: 2 })
      }
    }, store)
    store
      .getState()
      .setAgentStatus(point, { state: 'working', prompt: 'task' }, undefined, { updatedAt: 100 })
    expect(seen.map((pair) => pair.epoch)).toEqual([1, 2])
    const captured = status.getState()
    seen.length = 0
    store.getState().setAgentProgramStatus(point, facet)
    expect(seen).toEqual([{ state: 'working', epoch: 2 }])
    expect(captured.agentStatusByPaneKey[point].programStatus).toBeUndefined()
    expect(store.getState()).not.toHaveProperty('agentStatusByPaneKey')
    unsubscribe()
    store.getState().removeAgentStatus(point)
    expect(seen).toHaveLength(1)
  })

  it('records one exact automation output from done before recursive removal erases the current row', async () => {
    vi.useFakeTimers()
    const store = createStore(createAppState)
    const status = getAgentStatusOwner(store)
    const pane = 'automation-tab:1'
    const result = vi.fn(async () => undefined)
    const finalize = vi.fn(async () => null)
    const completion = createAutomationDispatchCompletion({
      statusOwner: status,
      run: makeRun(),
      worktree: makeWorktree({ id: 'automation-worktree', repoId: 'automation-repo' }),
      precheckResult: null,
      markDispatchResult: result,
      releaseTerminalOwnership: vi.fn(),
      finalizeTerminalOwnership: finalize
    })
    await completion.settlePendingAfterDispatch()
    completion.observeAgentStatus(pane, 100, { requireWorkingAfterStart: true })
    store
      .getState()
      .setAgentStatus(pane, { state: 'working', prompt: 'task' }, undefined, { updatedAt: 101 })
    let removed = false
    store.subscribe(() => {
      if (!removed && status.getEntry(pane)?.state === 'done') {
        removed = true
        store.getState().removeAgentStatus(pane)
        expect(status.getEntry(pane)).toBeUndefined()
        expect(result).not.toHaveBeenCalled()
      }
    })
    store.getState().setAgentStatus(
      pane,
      {
        state: 'done',
        prompt: 'task',
        lastAssistantMessage: '  exact final output  ',
        sessionBoundary: false
      },
      undefined,
      { updatedAt: 102 }
    )
    expect(removed).toBe(true)
    await Promise.resolve()
    expect(result).toHaveBeenCalledTimes(1)
    expect(result).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        outputSnapshot: expect.objectContaining({ content: 'exact final output' })
      })
    )
    expect(finalize).toHaveBeenCalledTimes(1)
    completion.cleanupRunObservers()
  })
})

describe('source-backed canonical read joins', () => {
  it('does not read or enumerate data sources until requested, and copies only the real prepared root', () => {
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    const marker = Symbol('data')
    const data: AgentStatusAppProbe = { ...store.getState() }
    Object.defineProperty(data, marker, { value: 'captured', enumerable: true })
    let reads = 0
    let enumerations = 0
    const source = new Proxy(data, {
      get(target, key) {
        if (key === marker) {
          reads++
        }
        return target[key]
      },
      ownKeys(target) {
        enumerations++
        return Reflect.ownKeys(target)
      }
    })
    store.setState(source, true)
    reads = 0
    enumerations = 0
    const committed: AgentStatusReadProbe = owner.getState()
    expect(owner.getState()).toBe(committed)
    expect(reads).toBe(0)
    expect(enumerations).toBe(0)
    owner.transact((transaction) => {
      const staged: AgentStatusReadProbe = transaction.getState()
      expect(transaction.getState()).toBe(staged)
      expect(reads).toBe(0)
      expect(enumerations).toBe(0)
      store.setState({ activeWorktreeId: 'prepared' })
      expect(reads).toBe(1)
      expect(enumerations).toBe(1)
      expect(transaction.getState()).toBe(staged)
      expect(staged.activeWorktreeId).toBe('prepared')
      expect(staged[marker]).toBe('captured')
      expect(store.getState()).toBe(source)
    })
    expect(store.getState().activeWorktreeId).toBe('prepared')
    expect(committed.activeWorktreeId).toBeNull()
    expect(committed[marker]).toBe('captured')
  })

  it('reflects own enumerable strings and symbols without letting a read mutate its sources', () => {
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    const marker = Symbol('value')
    const hidden = Symbol('hidden')
    const source = { ...store.getState() }
    Object.defineProperty(source, marker, { value: 42, enumerable: true })
    Object.defineProperty(source, hidden, { value: 99 })
    Object.defineProperty(source, 'hidden', { value: 'hidden' })
    store.setState(source, true)
    const read: AgentStatusReadProbe = owner.getState()
    expect(Object.keys(read)).toEqual([...Object.keys(source), 'agentStatusByPaneKey'])
    expect(Reflect.ownKeys(read)).toEqual([...Object.keys(source), 'agentStatusByPaneKey', marker])
    expect(Object.getOwnPropertyDescriptor(read, marker)).toEqual({
      value: 42,
      enumerable: true,
      configurable: true,
      writable: false
    })
    expect(read[marker]).toBe(42)
    expect(read[hidden]).toBeUndefined()
    expect(read.hidden).toBeUndefined()
    expect(Reflect.has(read, marker)).toBe(true)
    expect(Reflect.has(read, hidden)).toBe(false)
    expect(Reflect.has(read, 'hidden')).toBe(false)
    expect(read.toString).toBe(Object.prototype.toString)
    expect(read.__proto__).toBe(Object.prototype)
    const spread: AgentStatusReadProbe = { ...read }
    expect(spread[marker]).toBe(42)
    expect(spread.agentStatusByPaneKey).toBe(owner.getSnapshot())
    expect(Reflect.set(read, 'activeWorktreeId', 'wrong')).toBe(false)
    expect(Reflect.defineProperty(read, 'activeWorktreeId', { value: 'wrong' })).toBe(false)
    expect(Reflect.deleteProperty(read, 'activeWorktreeId')).toBe(false)
    expect(Reflect.setPrototypeOf(read, null)).toBe(false)
    expect(Reflect.preventExtensions(read)).toBe(false)
    expect(store.getState()).toBe(source)
    expect(source.activeWorktreeId).toBeNull()
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
  })

  it('keeps staged reads coherent after replacement and historical app/status pairs fixed', () => {
    vi.useFakeTimers()
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    store.getState().setAgentStatus('history:1', { state: 'working', prompt: 'first' })
    const before = owner.getState()
    const pairs: AgentStatusTransition[] = []
    owner.subscribeTransitions((pair) => pairs.push(pair))
    owner.transact((transaction) => {
      const read: AgentStatusReadProbe = transaction.getState()
      const replacement = {
        ...owner.getAppState(),
        transient: 'remove me',
        activeWorktreeId: 'new'
      }
      store.setState(replacement, true)
      expect(read.activeWorktreeId).toBe('new')
      expect(read.transient).toBe('remove me')
      Reflect.deleteProperty(replacement, 'transient')
      store.setState(replacement, true)
      expect(transaction.getState()).toBe(read)
      expect(Reflect.has(read, 'transient')).toBe(false)
      expect(read.transient).toBeUndefined()
      expect(Object.keys(read)).not.toContain('transient')
      store.getState().setAgentStatus('history:1', { state: 'done', prompt: 'second' })
      expect(read.agentStatusByPaneKey['history:1'].state).toBe('done')
      expect(before.agentStatusByPaneKey['history:1'].state).toBe('working')
    })
    expect(pairs).toHaveLength(1)
    const after = pairs[0].next
    expect(pairs[0].previous).toBe(before)
    expect(after.activeWorktreeId).toBe('new')
    store.setState({ activeWorktreeId: 'later' })
    store.getState().removeAgentStatus('history:1')
    expect(before.activeWorktreeId).toBeNull()
    expect(before.agentStatusByPaneKey['history:1'].prompt).toBe('first')
    expect(after.activeWorktreeId).toBe('new')
    expect(after.agentStatusByPaneKey['history:1'].state).toBe('done')
    expect(owner.getState().activeWorktreeId).toBe('later')
    expect(owner.getState().agentStatusByPaneKey['history:1']).toBeUndefined()
  })

  it('still evaluates actual app-root preparation before acceptance or effects', () => {
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    const source = { ...store.getState() }
    Object.defineProperty(source, 'activeWorktreeId', {
      enumerable: true,
      get() {
        throw new Error('real root preparation')
      }
    })
    store.setState(source, true)
    const previousLive = owner.getSnapshot()
    const effect = vi.fn()
    const notify = vi.fn()
    store.subscribe(notify)
    expect(() =>
      owner.transact((transaction) => {
        transaction.afterCommit(effect)
        store.setState({ agentStatusEpoch: 1 })
      })
    ).toThrow('real root preparation')
    expect(store.getState()).toBe(source)
    expect(owner.getSnapshot()).toBe(previousLive)
    expect(notify).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
  })
})
