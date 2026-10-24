import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createAppState } from './index'
import { getAgentStatusOwner, type AgentStatusTransaction } from './agent-status-commit'
import type { AgentStatusEntry } from './slices/agent-status-contract'
import { assertEditorBufferInvariant } from './editor-buffer-record-lifecycle'
import { getStructuredAgentSessionReadOwner } from '../components/native-chat/structured-agent-session-read-owner'
import {
  findStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests,
  retireStructuredAgentSessionReadOwner,
  forgetStructuredReadOwner,
  structuredReadOwnerKey
} from '../components/native-chat/structured-agent-session-read-owner-registry'
import { makeOpenFile } from './slices/store-session-test-harness'
import { makeWorktree, TEST_REPO } from './slices/worktrees-slice-test-fixtures'
import type { AgentStatusReadState, AgentStatusTransition } from './agent-status-observers'

const row = (paneKey: string, state: AgentStatusEntry['state'] = 'working'): AgentStatusEntry => ({
  paneKey,
  state,
  prompt: 'task',
  agentType: 'codex',
  stateStartedAt: 10,
  updatedAt: state === 'done' ? 20 : 10,
  stateHistory: []
})

afterEach(() => {
  resetStructuredAgentSessionReadOwnersForTests()
  vi.restoreAllMocks()
})

describe('real AppStore status commit boundary', () => {
  it.each([10, 100])(
    'isolates keyed writes across %i rows and preserves net-zero identities',
    (n) => {
      const store = createStore(createAppState)
      const owner = getAgentStatusOwner(store)
      const app = vi.fn()
      const aggregate = vi.fn()
      const points = Array.from({ length: n }, () => vi.fn())
      points.forEach((listener, key) => owner.subscribeEntry(String(key), listener))
      store.subscribe(app)
      owner.subscribeAggregate(aggregate)
      owner.transact((transaction) => {
        for (let key = 0; key < n; key++) {
          transaction.setEntry(String(key), row(String(key)))
        }
      })
      const initial = owner.getSnapshot()
      const first = initial['0']
      points.forEach((point) => point.mockClear())
      aggregate.mockClear()
      owner.transact((transaction) => {
        transaction.setEntry('0', { ...first, prompt: 'changed' })
        expect(transaction.getState().agentStatusByPaneKey['0'].prompt).toBe('changed')
        expect(owner.getEntry('0')).toBe(first)
        transaction.setEntry('0', first)
      })
      expect(owner.getSnapshot()).toBe(initial)
      expect(aggregate).not.toHaveBeenCalled()
      owner.transact((transaction) => {
        transaction.setEntry('0', { ...first, prompt: 'changed' })
        transaction.setEntry('0', {
          ...transaction.getState().agentStatusByPaneKey['0'],
          model: 'next'
        })
      })
      expect(points[0]).toHaveBeenCalledTimes(1)
      expect(points.slice(1).every((point) => point.mock.calls.length === 0)).toBe(true)
      expect(aggregate).toHaveBeenCalledTimes(1)
      expect(app).not.toHaveBeenCalled()
      expect(owner.getSnapshot()['1']).toBe(initial['1'])
      expect(getAgentStatusOwner(createStore(createAppState)).getSnapshot()).toEqual({})
    }
  )

  it.each([10, 100])('materializes one staged app view for a %i-row fold', (n) => {
    for (const paired of [false, true]) {
      const store = createStore(createAppState)
      const owner = getAgentStatusOwner(store)
      owner.transact((transaction) => {
        for (let key = 0; key < n; key++) {
          transaction.setEntry(String(key), row(String(key)))
        }
      })
      const materializations = vi.fn(() => null)
      Object.defineProperty(store.getState(), 'activeWorktreeId', {
        enumerable: true,
        configurable: true,
        get: materializations
      })
      const pairs: AgentStatusTransition[] = []
      if (paired) {
        owner.subscribeTransitions((transition) => pairs.push(transition))
      }
      const app = vi.fn()
      store.subscribe(app)
      const reads: AgentStatusReadState[] = []
      owner.transact((transaction) => {
        for (let key = 0; key < n; key++) {
          const view = transaction.getState()
          reads.push(view)
          const current = view.agentStatusByPaneKey[String(key)]
          transaction.setEntry(String(key), { ...current, prompt: 'folded' })
        }
      })
      expect(materializations).toHaveBeenCalledTimes(paired ? 3 : 1)
      expect(new Set(reads).size).toBe(1)
      expect(app).not.toHaveBeenCalled()
      if (paired) {
        expect(pairs[0].previous.agentStatusByPaneKey['0'].prompt).toBe('task')
        expect(pairs[0].next.agentStatusByPaneKey['0'].prompt).toBe('folded')
      }
      materializations.mockClear()
      store.setState({ activeWorktreeId: 'next' })
      expect(materializations).toHaveBeenCalledTimes(1)
    }
  })

  it('installs prepared reader retirement before observers and disposes only captured readers', () => {
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    const session = 'status-boundary-reader'
    const target = { kind: 'local' } as const
    const reader = getStructuredAgentSessionReadOwner(session, target)
    const dispose = vi.spyOn(reader, 'dispose')
    store.setState({
      unifiedTabsByWorktree: {
        wt: [
          {
            id: 'chat',
            entityId: session,
            groupId: 'g',
            worktreeId: 'wt',
            executionHostId: 'local',
            contentType: 'agent-session',
            label: 'Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    owner.transact((transaction) => transaction.setEntry('p', row('p')))
    const previous = store.getState()
    const statuses = owner.getSnapshot()
    const prepareRemoval = (transaction: AgentStatusTransaction): void => {
      transaction.retireReadOwner(session, target)
      transaction.setEntry('p', undefined)
      store.setState({ unifiedTabsByWorktree: { wt: [] } })
    }
    expect(() =>
      owner.transact((transaction) => {
        prepareRemoval(transaction)
        expect(findStructuredAgentSessionReadOwner(session, target)).toBe(reader)
        throw new Error('abort retirement')
      })
    ).toThrow('abort retirement')
    expect(store.getState()).toBe(previous)
    expect(owner.getSnapshot()).toBe(statuses)
    expect(findStructuredAgentSessionReadOwner(session, target)).toBe(reader)
    expect(dispose).not.toHaveBeenCalled()
    forgetStructuredReadOwner(structuredReadOwnerKey(session, target), reader)
    const releaseAfterAbort = reader.subscribe(vi.fn())
    expect(findStructuredAgentSessionReadOwner(session, target)).toBe(reader)
    releaseAfterAbort()
    const releaseIdleReplay = reader.subscribe(vi.fn())
    expect(findStructuredAgentSessionReadOwner(session, target)).toBe(reader)
    const observed: unknown[] = []
    const app = vi.fn(() => {
      observed.push([
        store.getState().unifiedTabsByWorktree.wt,
        owner.getEntry('p'),
        findStructuredAgentSessionReadOwner(session, target),
        dispose.mock.calls.length
      ])
      getStructuredAgentSessionReadOwner(session, target)
    })
    const stop = store.subscribe(app)
    owner.transact(prepareRemoval)
    expect(observed).toEqual([[[], undefined, undefined, 0]])
    expect(dispose).toHaveBeenCalledTimes(1)
    const replacement = findStructuredAgentSessionReadOwner(session, target)
    expect(replacement).toBeDefined()
    expect(replacement).not.toBe(reader)
    stop()
    const acceptedApp = store.getState()
    const acceptedStatus = owner.getSnapshot()
    const point = vi.fn()
    owner.subscribeEntry('p', point)
    owner.transact((transaction) => transaction.retireReadOwner(session, target))
    expect(findStructuredAgentSessionReadOwner(session, target)).toBeUndefined()
    expect(store.getState()).toBe(acceptedApp)
    expect(owner.getSnapshot()).toBe(acceptedStatus)
    expect(app).toHaveBeenCalledTimes(1)
    expect(point).not.toHaveBeenCalled()
    releaseIdleReplay()
  })

  it.each([false, true])(
    'composes two stores retiring shared readers (abort outer: %s)',
    (abort) => {
      const storeA = createStore(createAppState)
      const storeB = createStore(createAppState)
      const ownerA = getAgentStatusOwner(storeA)
      const ownerB = getAgentStatusOwner(storeB)
      const target = { kind: 'local' } as const
      const a = getStructuredAgentSessionReadOwner('reader-a', target)
      const b = getStructuredAgentSessionReadOwner('reader-b', target)
      const disposeA = vi.spyOn(a, 'dispose')
      const disposeB = vi.spyOn(b, 'dispose')
      const observed: unknown[] = []
      storeA.subscribe(() =>
        observed.push([
          findStructuredAgentSessionReadOwner('reader-a', target),
          findStructuredAgentSessionReadOwner('reader-b', target),
          findStructuredAgentSessionReadOwner('reader-c', target)
        ])
      )
      let replacement: typeof a | undefined
      let unrelated: typeof a | undefined
      const appA = storeA.getState()
      const run = (): void =>
        ownerA.transact((transactionA) => {
          transactionA.retireReadOwner('reader-a', target)
          ownerB.transact((transactionB) => {
            transactionB.retireReadOwner('reader-a', target)
            transactionB.retireReadOwner('reader-b', target)
          })
          expect(findStructuredAgentSessionReadOwner('reader-b', target)).toBeUndefined()
          expect(disposeA).toHaveBeenCalledTimes(1)
          expect(disposeB).toHaveBeenCalledTimes(1)
          replacement = getStructuredAgentSessionReadOwner('reader-a', target)
          unrelated = getStructuredAgentSessionReadOwner('reader-c', target)
          storeA.setState({ activeWorktreeId: 'accepted-a' })
          if (abort) {
            throw new Error('abort outer retirement')
          }
        })
      if (abort) {
        expect(run).toThrow('abort outer retirement')
        expect(storeA.getState()).toBe(appA)
      } else {
        run()
      }
      expect(observed).toEqual(abort ? [] : [[replacement, undefined, unrelated]])
      expect(findStructuredAgentSessionReadOwner('reader-a', target)).toBe(replacement)
      expect(findStructuredAgentSessionReadOwner('reader-b', target)).toBeUndefined()
      expect(findStructuredAgentSessionReadOwner('reader-c', target)).toBe(unrelated)
      expect(disposeA).toHaveBeenCalledTimes(1)
      expect(disposeB).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['held-delivery', 'aba-accept', 'aba-abort', 'direct'] as const)(
    'ends forced-retired reader lifetime: %s',
    (trace) => {
      const storeA = createStore(createAppState)
      const storeB = createStore(createAppState)
      const ownerA = getAgentStatusOwner(storeA)
      const ownerB = getAgentStatusOwner(storeB)
      const target = { kind: 'local' } as const
      const session = 'terminal-reader-lifetime'
      const reader = getStructuredAgentSessionReadOwner(session, target)
      const disposed = vi.spyOn(reader, 'dispose')
      const refused = vi.fn()
      const delivered = vi.fn()
      let fresh: typeof reader | undefined
      let releaseFresh = (): void => {}
      const reacquire = (): void => {
        const release = reader.subscribe(refused)
        expect(findStructuredAgentSessionReadOwner(session, target)).toBeUndefined()
        const deactivate = reader.activate()
        expect(findStructuredAgentSessionReadOwner(session, target)).toBeUndefined()
        release()
        deactivate()
        fresh = getStructuredAgentSessionReadOwner(session, target)
        expect(fresh).not.toBe(reader)
        releaseFresh = fresh.subscribe(delivered)
      }
      if (trace === 'held-delivery') {
        storeB.subscribe(reacquire)
      }
      if (trace === 'direct') {
        retireStructuredAgentSessionReadOwner(session, target)
        reacquire()
      } else {
        const run = (): void =>
          ownerA.transact((transactionA) => {
            transactionA.retireReadOwner(session, target)
            ownerB.transact((transactionB) => {
              transactionB.retireReadOwner(session, target)
              if (trace === 'held-delivery') {
                storeB.setState({ activeWorktreeId: 'retired-b' })
              }
            })
            if (trace !== 'held-delivery') {
              reacquire()
            }
            storeA.setState({ activeWorktreeId: 'retired-a' })
            if (trace !== 'aba-accept') {
              throw new Error('abort outer')
            }
          })
        if (trace === 'aba-accept') {
          run()
        } else {
          expect(run).toThrow('abort outer')
        }
      }
      expect(disposed).toHaveBeenCalledTimes(1)
      expect(findStructuredAgentSessionReadOwner(session, target)).toBe(fresh)
      const cursor = { epoch: 'fresh-reader', sequence: 0 }
      fresh?.publishCreated({
        sessionId: session,
        epoch: cursor.epoch,
        direction: 'tail',
        items: [],
        removedItemIds: [],
        submissions: [],
        window: { oldest: null, newest: null, nextCursor: cursor },
        liveCursor: cursor,
        hasOlder: false,
        hasNewer: false
      })
      expect(delivered).toHaveBeenCalledTimes(1)
      expect(refused).not.toHaveBeenCalled()
      releaseFresh()
    }
  )

  it('keeps ordinary app recursion and captures completion before synchronous removal', () => {
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    owner.transact((transaction) => transaction.setEntry('p', row('p')))
    const pairs: AgentStatusTransition[] = []
    const latest: (AgentStatusEntry | undefined)[] = []
    let nestedFlag = false
    let observedNestedFlag = false
    let nested = false
    owner.subscribeTransitions((transition) => pairs.push(transition), 'p')
    owner.subscribeEntry('p', () => latest.push(owner.getEntry('p')))
    store.subscribe(() => {
      if (nested || owner.getEntry('p')?.state !== 'done') {
        return
      }
      nested = true
      store.setState({ activeWorktreeId: 'nested' })
      observedNestedFlag = nestedFlag
      owner.transact((transaction) => {
        transaction.setEntry('p', undefined)
        store.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
      })
    })
    store.subscribe((state) => {
      if (state.activeWorktreeId === 'nested') {
        nestedFlag = true
      }
    })
    owner.transact((transaction) => {
      transaction.setEntry('p', row('p', 'done'))
      store.setState({ agentStatusEpoch: 1 })
    })
    expect(pairs.map((pair) => pair.next.agentStatusByPaneKey.p?.state)).toEqual([
      'done',
      undefined
    ])
    expect(pairs.map((pair) => pair.previous.agentStatusByPaneKey.p?.state)).toEqual([
      'working',
      'done'
    ])
    expect(pairs[0].next.agentStatusEpoch).toBe(1)
    expect(observedNestedFlag).toBe(true)
    expect(pairs[1].next.agentStatusEpoch).toBe(2)
    expect(pairs[0].sequence).toBeLessThan(pairs[1].sequence)
    expect(latest).toEqual([undefined, undefined])
    expect(store.getState().activeWorktreeId).toBe('nested')
    expect(owner.getEntry('p')).toBeUndefined()
  })

  it('prepares real editor invariants once and abandons effects on updater or draft failure', () => {
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    store.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'local' }],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt', repoId: TEST_REPO.id })] },
      openFiles: ['a', 'b'].map((id) =>
        makeOpenFile({ id, worktreeId: 'wt', filePath: '/same.txt', runtimeEnvironmentId: null })
      )
    })
    expect(Object.values(store.getState().editorBufferViews)).toContainEqual(['a', 'b'])
    const previous = store.getState()
    const initial = owner.getSnapshot()
    const app = vi.fn()
    const accepted = vi.fn()
    const effect = vi.fn()
    const updater = vi.fn(() => {
      expect(owner.getSnapshot()).toBe(initial)
      expect(store.getState()).toBe(previous)
      throw new Error('updater failed')
    })
    store.subscribe(app)
    owner.subscribeTransitions(accepted)
    for (const write of [
      () => store.setState(updater),
      () => store.setState({ editorDrafts: { a: 'only one view' } })
    ]) {
      expect(() =>
        owner.transact((transaction) => {
          transaction.setEntry('p', row('p'))
          transaction.afterCommit(effect)
          write()
        })
      ).toThrow()
      expect(store.getState()).toBe(previous)
      expect(owner.getSnapshot()).toBe(initial)
    }
    expect(updater).toHaveBeenCalledTimes(1)
    expect(app).not.toHaveBeenCalled()
    expect(accepted).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    const valid = vi.fn(() => ({ editorDrafts: { a: 'same', b: 'same' } }))
    const observedPairs: (AgentStatusEntry | undefined)[] = []
    const invariantErrors: unknown[] = []
    store.subscribe((state) => {
      try {
        assertEditorBufferInvariant(state)
      } catch (error) {
        invariantErrors.push(error)
      }
      observedPairs.push(owner.getEntry('p'))
    })
    expect(
      owner.transact((transaction) => {
        transaction.setEntry('p', row('p'))
        store.setState(valid)
        transaction.afterCommit(effect)
        return 'accepted'
      })
    ).toBe('accepted')
    expect(valid).toHaveBeenCalledTimes(1)
    expect(invariantErrors).toEqual([])
    expect(observedPairs.map((entry) => entry?.state)).toEqual(['working'])
    expect(effect).toHaveBeenCalledTimes(1)
    expect(accepted).toHaveBeenCalledTimes(1)
  })

  it('isolates accepted observers, keeps subscription lifetimes and preserves unrelated errors', () => {
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    const error = new Error('observer failed')
    const report = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('reporter failed')
    })
    const late = vi.fn()
    const disposed = vi.fn()
    const unsubscribe = owner.subscribeEntry('p', disposed)
    const stopThrowing = store.subscribe(() => {
      unsubscribe()
      owner.subscribeTransitions(late, 'p')
      throw error
    })
    const app = vi.fn()
    store.subscribe(app)
    owner.subscribeEntry('p', () => {
      throw error
    })
    const aggregate = vi.fn()
    owner.subscribeAggregate(aggregate)
    const finalEffect = vi.fn()
    expect(
      owner.transact((transaction) => {
        transaction.setEntry('p', row('p'))
        store.setState({ agentStatusEpoch: 1 })
        transaction.afterCommit(() => {
          throw error
        })
        transaction.afterCommit(finalEffect)
        return true
      })
    ).toBe(true)
    expect(app).toHaveBeenCalledTimes(1)
    expect(aggregate).toHaveBeenCalledTimes(1)
    expect(finalEffect).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(3)
    expect(disposed).not.toHaveBeenCalled()
    expect(late).not.toHaveBeenCalled()
    stopThrowing()
    const stopOrdinary = store.subscribe(() => {
      throw error
    })
    expect(() => store.setState({ activeWorktreeId: 'ordinary' })).toThrow(error)
    stopOrdinary()
    owner.transact((transaction) => transaction.setEntry('p', undefined))
    expect(late).toHaveBeenCalledTimes(1)
  })
})

it.each([false, true])(
  'samples each ordinary updater frame after nested accepted work (throw %s)',
  (throws) => {
    const store = createStore(createAppState),
      owner = getAgentStatusOwner(store)
    owner.transact((tx) => tx.setEntry('updater:1', row('updater:1')))
    const pairs: AgentStatusTransition[] = []
    owner.subscribeTransitions((pair) => pairs.push(pair))
    const effect = vi.fn()
    const updater = vi.fn(() => {
      owner.transact((tx) => {
        tx.setEntry('updater:1', row('updater:1', 'done'))
        tx.afterCommit(effect)
      })
      store.setState({ sortEpoch: 11 })
      if (throws) {
        throw new Error('outer updater failed')
      }
      return { sortEpoch: 123 }
    })
    if (throws) {
      expect(() => store.setState(updater)).toThrow('outer updater failed')
    } else {
      store.setState(updater)
    }
    expect(updater).toHaveBeenCalledTimes(1)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(store.getState().sortEpoch).toBe(throws ? 11 : 123)
    expect(
      pairs.map((pair) => [
        pair.previous.agentStatusByPaneKey['updater:1']?.state,
        pair.next.agentStatusByPaneKey['updater:1']?.state,
        pair.previous.sortEpoch,
        pair.next.sortEpoch
      ])
    ).toEqual([
      ['working', 'done', 0, 0],
      ['done', 'done', 0, 11],
      ...(throws ? [] : [['done', 'done', 11, 123]])
    ])
  }
)
