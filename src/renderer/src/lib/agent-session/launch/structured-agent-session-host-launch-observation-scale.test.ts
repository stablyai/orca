// @vitest-environment happy-dom
// Many held launches at once, each with its own chat: what Close and an unload cost while their
// returns wait on their drafts, through the launches' own Prepare, Release, Retry and Close.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  deferred,
  draft
} from '../../structured-agent-session-launch-create-message.test-fixture'
import {
  cancelStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch
} from './structured-agent-session-launch'
import { getStructuredLaunchStateBySessionId } from './structured-agent-session-launch-registry'
import {
  deleteNativeChatComposerDraftsWhere,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import { draftCustody } from '@/components/native-chat/native-chat-composer-draft-custody'
import { scopeInputs } from '@/components/native-chat/native-chat-composer-draft-input'
import {
  dirtyScopes,
  load,
  unconfirmed
} from '@/components/native-chat/native-chat-composer-draft-memory'
import {
  nativeChatDraftHasReceipt,
  nativeChatDraftReceiptProgress
} from '@/components/native-chat/native-chat-composer-draft-handback'
import {
  appendNativeChatDraftCache,
  writeNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { nativeChatComposerDraftStorage } from '@/components/native-chat/native-chat-composer-draft-storage'
import type * as ReceiptEvents from '@/components/native-chat/native-chat-composer-draft-receipt-events'
import type { AgentLaunchReleasePhaseStatusResult } from '../../../../../shared/rpc-contract/agent-launch-accept-params'
import {
  AWAITING,
  HELD,
  SAVED,
  host,
  hostAnswers,
  refuseDraftWrites,
  restartRenderer,
  seedCatalog,
  startReleaseLaunch,
  type HeldLaunch
} from './structured-agent-session-host-launch.test-fixture'

// Removable receipt-progress subscribers the custody layer holds, counted where they are added.
const receiptListeners = vi.hoisted(() => ({ live: 0 }))
vi.mock('@/components/native-chat/native-chat-composer-draft-receipt-events', async (original) => {
  const actual = await original<typeof ReceiptEvents>()
  return {
    ...actual,
    addNativeChatDraftReceiptListener: (
      ...args: Parameters<typeof actual.addNativeChatDraftReceiptListener>
    ) => {
      receiptListeners.live += 1
      const stop = actual.addNativeChatDraftReceiptListener(...args)
      let stopped = false
      return () => {
        if (!stopped) {
          stopped = true
          receiptListeners.live -= 1
        }
        stop()
      }
    }
  }
})

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
  hostAnswers()
  mocks.exactSupport.mockResolvedValue(true)
  seedCatalog()
})
afterEach(() => {
  vi.restoreAllMocks()
  refuseDraftWrites(false)
  cleanupCreateMessageFixture(restore)
})

describe('many launches whose returns wait on their drafts', () => {
  const JOURNAL = 'orca:nativeChatComposerDraftJournal:v1'
  const scopeOf = (launch: HeldLaunch) => `agent-session:${launch.sessionId}`
  const receiptOf = (launch: HeldLaunch) => ({
    operationId: launch.operationId,
    clientMessageId: launch.messageId
  })

  function launchesOf(count: number): HeldLaunch[] {
    return Array.from({ length: count }, (_, index) => ({
      sessionId: `codex_held_${count}_${index}`,
      operationId: `${Date.now()}-${String(index + 100).padStart(32, '0')}`,
      messageId: `${Date.now()}-${String(index + 300).padStart(32, '0')}`,
      source: `pending-worktree-creation:held-${count}-${index}`
    }))
  }

  /** Each launch starts from its own draft A and is Released; its later reads wait on `answer`. */
  async function releaseLaunches(
    launches: readonly HeldLaunch[],
    answer: (operationId: string) => Promise<AgentLaunchReleasePhaseStatusResult>
  ): Promise<void> {
    const read = new Set<string>()
    const running = async (params: unknown) => ({
      operationId: (params as { operationId: string }).operationId,
      state: 'running'
    })
    host.prepare.mockImplementation(running)
    host.release.mockImplementation(running)
    host.status.mockImplementation(async (params) => {
      const { operationId } = params as { operationId: string }
      if (read.has(operationId)) {
        return answer(operationId)
      }
      read.add(operationId)
      return AWAITING
    })
    for (const [index, launch] of launches.entries()) {
      updateNativeChatComposerDraft(
        launch.source,
        { text: 'Also run lint', images: [] },
        'immediate'
      )
      startReleaseLaunch(launch)
      await vi.waitFor(() => expect(host.release).toHaveBeenCalledTimes(index + 1))
    }
    await nativeChatComposerDraftWritesSettled()
  }

  /** The draft store's own saves of these scopes read their record once `gate` opens, and
   *  report it saved once `settled` does; others save at once. */
  function holdDraftSaves(
    scopes: ReadonlySet<string>,
    gate: () => Promise<void>,
    settled: () => Promise<void> = async () => {}
  ) {
    const backend = nativeChatComposerDraftStorage()
    const update = backend.update.bind(backend)
    return vi.spyOn(backend, 'update').mockImplementation((key, apply) =>
      scopes.has(key)
        ? gate()
            .then(() => update(key, apply))
            .then(settled)
        : update(key, apply)
    )
  }

  function refuse(key: string) {
    const setItem = localStorage.setItem.bind(localStorage)
    return vi.spyOn(localStorage, 'setItem').mockImplementation((name, value) => {
      if (name === key) {
        throw new DOMException('full', 'QuotaExceededError')
      }
      setItem(name, value)
    })
  }

  /** Visits of the draft store's receipt-listener buckets (a Map of Sets of listener entries)
   *  while `run` runs, and the entries removed from them; every other Map and Set runs as is. */
  function receiptBucketWork(run: () => void): { visits: number; removals: number } {
    const work = { visits: 0, removals: 0 }
    const map = Map.prototype
    const native = {
      iterator: map[Symbol.iterator],
      entries: map.entries,
      values: map.values,
      keys: map.keys,
      forEach: map.forEach,
      remove: Set.prototype.delete
    }
    const isEntry = (value: unknown) =>
      typeof value === 'object' && value !== null && 'listener' in value && 'receipt' in value
    const isBuckets = (target: Map<unknown, unknown>) => {
      const members: unknown = native.values.call(target).next().value
      return members instanceof Set && isEntry(members.values().next().value)
    }
    const counted = (method: 'iterator' | 'entries' | 'values' | 'keys') =>
      function (this: Map<unknown, unknown>) {
        const iterator = native[method].call(this)
        if (!isBuckets(this)) {
          return iterator
        }
        return {
          next: () => {
            const step = iterator.next()
            work.visits += step.done ? 0 : 1
            return step
          },
          [Symbol.iterator]() {
            return this
          }
        }
      }
    try {
      Object.assign(map, {
        [Symbol.iterator]: counted('iterator'),
        entries: counted('entries'),
        values: counted('values'),
        keys: counted('keys'),
        forEach(
          this: Map<unknown, unknown>,
          ...args: Parameters<Map<unknown, unknown>['forEach']>
        ) {
          work.visits += isBuckets(this) ? this.size : 0
          native.forEach.apply(this, args)
        }
      })
      Set.prototype.delete = function (this: Set<unknown>, value: unknown) {
        work.removals += isEntry(value) ? 1 : 0
        return native.remove.call(this, value)
      }
      run()
    } finally {
      Object.assign(map, {
        [Symbol.iterator]: native.iterator,
        entries: native.entries,
        values: native.values,
        keys: native.keys,
        forEach: native.forEach
      })
      Set.prototype.delete = native.remove
    }
    return work
  }

  it.each([3, 30])(
    'closes %i launches whose returns wait on held saves, each at its own listener',
    async (count) => {
      const launches = launchesOf(count)
      const parents = new Map(
        launches.map((launch) => [
          launch.operationId,
          deferred<AgentLaunchReleasePhaseStatusResult>()
        ])
      )
      await releaseLaunches(launches, (operationId) => parents.get(operationId)!.promise)
      // Every return's save is held and its journal fallback refused.
      const held = Promise.withResolvers<void>()
      const blocked = holdDraftSaves(new Set(launches.map(scopeOf)), () => held.promise)
      const journal = refuse(JOURNAL)
      for (const launch of launches) {
        parents.get(launch.operationId)!.resolve({ state: 'unknown' })
        await vi.waitFor(() =>
          expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.callers.outcome).toBe(
            'unknown'
          )
        )
        expect(draft(launch.sessionId)).toBe(`Also run lint\n\n${HELD}`)
        expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.intent.opening).toBeDefined()
      }
      expect(receiptListeners.live).toBe(count)

      const work = receiptBucketWork(() => {
        for (const launch of launches) {
          expect(cancelStructuredAgentLaunch('workspace-1', launch.sessionId)).toBe(true)
        }
      })
      for (const launch of launches) {
        expect(getStructuredLaunchStateBySessionId(launch.sessionId)).toBeUndefined()
      }
      expect(receiptListeners.live).toBe(0)
      // Bound: each Close removes its own listener from its own bucket and visits no other.
      expect(work).toEqual({ visits: 0, removals: count })

      // The held saves may still finish; nothing of the closed launches comes back.
      journal.mockRestore()
      held.resolve()
      await nativeChatComposerDraftWritesSettled()
      expect(receiptListeners.live).toBe(0)
      for (const launch of launches) {
        expect(getStructuredLaunchStateBySessionId(launch.sessionId)).toBeUndefined()
      }
      expect(host.prepare).toHaveBeenCalledTimes(count)
      expect(host.release).toHaveBeenCalledTimes(count)
      blocked.mockRestore()
    }
  )

  /** The shared journal key's actual work at the Storage and JSON boundaries, before any filter. */
  function journalWork() {
    const work = { reads: 0, parses: 0, parsedChars: 0, writes: 0, chars: 0, encodings: 0 }
    let read: string | null = null
    const getItem = localStorage.getItem.bind(localStorage)
    const setItem = localStorage.setItem.bind(localStorage)
    const removeItem = localStorage.removeItem.bind(localStorage)
    const parse = JSON.parse
    const stringify = JSON.stringify
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) => {
      const value = getItem(key)
      if (key === JOURNAL) {
        work.reads += 1
        read = value
      }
      return value
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === JOURNAL) {
        work.writes += 1
        work.chars += value.length
      }
      setItem(key, value)
    })
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
      work.writes += key === JOURNAL ? 1 : 0
      removeItem(key)
    })
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      // A parse of the journal text just read, whoever reads it.
      if (typeof text === 'string' && text === read) {
        read = null
        work.parses += 1
        work.parsedChars += text.length
      }
      return parse(text, reviver)
    })
    vi.spyOn(JSON, 'stringify').mockImplementation((value, ...rest) => {
      if (typeof value === 'object' && value !== null && 'scopeKey' in value) {
        work.encodings += 1
      }
      return stringify(value, ...(rest as [undefined]))
    })
    /** What was counted since the last take. */
    return () => {
      const taken = { ...work }
      Object.assign(work, {
        reads: 0,
        parses: 0,
        parsedChars: 0,
        writes: 0,
        chars: 0,
        encodings: 0
      })
      return taken
    }
  }

  /** The earlier-run journal's own upstream work while measured, before any filter: journal entries
   *  visited by any array pass over them, earlier-run scopes added to an index of them, and
   *  lookups in that index. Every operation still runs natively. */
  function snapshotWork() {
    const CORPUS = /^tab-\d+:pane$/
    // A journal entry, read or encoded for the shared key.
    const isEntry = (item: unknown): boolean => {
      const value =
        typeof item === 'object' && item !== null && 'entry' in item && 'text' in item
          ? (item as { entry: unknown }).entry
          : item
      return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { scopeKey?: unknown }).scopeKey === 'string' &&
        typeof (value as { at?: unknown }).at === 'number' &&
        ('draft' in value || 'addition' in value)
      )
    }
    const ofEntries = (list: unknown) => Array.isArray(list) && list.length > 0 && isEntry(list[0])
    const array = Array.prototype as unknown as Record<PropertyKey, unknown>
    const passes = ['filter', 'map', 'flatMap', 'forEach', 'some', 'every', 'find', 'reduce']
    const native = new Map<PropertyKey, unknown>(
      [...passes, Symbol.iterator].map((name) => [name, array[name]])
    )
    const { get, set, values } = Map.prototype
    const work = { entryVisits: 0, indexAdds: 0, indexLookups: 0 }
    const stop = () => {
      native.forEach((method, name) => (array[name] = method))
      Object.assign(Map.prototype, { get, set })
    }
    onTestFinished(stop)
    const start = () => {
      for (const name of passes) {
        const run = native.get(name) as (...args: unknown[]) => unknown
        array[name] = function (this: unknown[], ...args: unknown[]) {
          work.entryVisits += ofEntries(this) ? this.length : 0
          return run.apply(this, args)
        }
      }
      const iterate = native.get(Symbol.iterator) as (this: unknown[]) => Iterator<unknown>
      array[Symbol.iterator] = function (this: unknown[]) {
        const iterator = iterate.call(this)
        if (!ofEntries(this)) {
          return iterator
        }
        return {
          next: () => {
            const step = iterator.next()
            work.entryVisits += step.done ? 0 : 1
            return step
          },
          [Symbol.iterator]() {
            return this
          }
        }
      }
      Object.assign(Map.prototype, {
        set(this: Map<unknown, unknown>, key: unknown, value: unknown) {
          work.indexAdds +=
            typeof key === 'string' && CORPUS.test(key) && Array.isArray(value) ? 1 : 0
          return set.call(this, key, value)
        },
        get(this: Map<unknown, unknown>, key: unknown) {
          work.indexLookups += ofEntries(values.call(this).next().value) ? 1 : 0
          return get.call(this, key)
        }
      })
    }
    /** Counts what `run` does, then stops counting. */
    return async (run: () => Promise<unknown>) => {
      Object.assign(work, { entryVisits: 0, indexAdds: 0, indexLookups: 0 })
      start()
      try {
        await run()
      } finally {
        stop()
      }
      return { ...work }
    }
  }

  /** What an unload collects before any filter: the dirty and unconfirmed scopes it visits, and
   *  the pending contributions it reads. Each still runs natively. */
  function collectorWork(run: () => void) {
    const work = { dirty: 0, unconfirmed: 0, pending: 0 }
    const counting =
      <T>(iterate: () => Iterator<T>, key: 'dirty' | 'unconfirmed') =>
      () => {
        const iterator = iterate()
        return {
          next: () => {
            const step = iterator.next()
            work[key] += step.done ? 0 : 1
            return step
          },
          [Symbol.iterator]() {
            return this
          }
        }
      }
    const each = Array.prototype.forEach
    const ownUnconfirmed = unconfirmed[Symbol.iterator].bind(unconfirmed)
    const ownDirty = dirtyScopes[Symbol.iterator].bind(dirtyScopes)
    const restore = [
      vi
        .spyOn(unconfirmed, Symbol.iterator)
        .mockImplementation(counting(ownUnconfirmed, 'unconfirmed') as never),
      vi
        .spyOn(dirtyScopes, Symbol.iterator)
        .mockImplementation(counting(ownDirty, 'dirty') as never)
    ]
    Array.prototype.forEach = function (this: unknown[], ...args: Parameters<typeof each>) {
      const first = this[0]
      if (
        typeof first === 'object' &&
        first !== null &&
        'receipt' in first &&
        'contribution' in first
      ) {
        work.pending += this.length
      }
      return each.apply(this, args)
    }
    try {
      run()
    } finally {
      Array.prototype.forEach = each
      restore.forEach((spy) => spy.mockRestore())
    }
    return work
  }

  it.each([
    [3, 'lands'],
    [30, 'lands'],
    [3, 'fails'],
    [30, 'fails']
  ] as const)(
    'unloads %i returns waiting on their unread drafts in one journal write, read from one snapshot, when the older load %s',
    async (count, outcome) => {
      // What anything still owns of these chats' bases: the reading load's exclusions and any
      // input not yet resolved at a read.
      const owned = () =>
        launches.filter(
          (launch) =>
            load.attempt?.excluded.has(scopeOf(launch)) || scopeInputs.has(scopeOf(launch))
        ).length
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const launches = launchesOf(count)
      // Released; the host has said nothing more before the restart.
      await releaseLaunches(launches, () => new Promise(() => {}))
      const backend = nativeChatComposerDraftStorage() as ReturnType<
        typeof nativeChatComposerDraftStorage
      > & { drafts: Map<string, { text: string; handbacks?: unknown }> }
      // An earlier run's journal of unrelated panes.
      const corpus = Array.from({ length: count }, (_, index) => ({
        scopeKey: `tab-${index}:pane`,
        draft: { text: `unrelated ${index}`, images: [], savedAt: 2 },
        at: 2,
        run: 'earlier'
      }))
      localStorage.setItem(JOURNAL, JSON.stringify(corpus))

      // A restart whose first load attempt fails, and whose second is held, as is every chat's
      // own read of its draft; only the launches' own rows cannot be saved.
      restartRenderer()
      const loadAll = backend.loadAll.bind(backend)
      const landed = Promise.withResolvers<void>()
      vi.spyOn(backend, 'loadAll')
        .mockRejectedValueOnce(new Error('busy'))
        .mockImplementation(async () => {
          const drafts = await loadAll()
          await landed.promise
          return drafts
        })
      const reads = Promise.withResolvers<void>()
      const saves = Promise.withResolvers<void>()
      holdDraftSaves(
        new Set(launches.map(scopeOf)),
        () => reads.promise,
        () => saves.promise
      )
      const take = journalWork()
      const measure = snapshotWork()
      // Bound: an attempt reads and parses the whole journal once, at its read boundary, and a
      // new attempt takes its own. It visits each entry a fixed number of times (parse,
      // earlier-run selection, scope index, setup-scope selection) and indexes each earlier-run
      // scope once.
      const whole = { reads: 1, parses: 1, parsedChars: JSON.stringify(corpus).length }
      for (const attempt of [
        () => (void hydrateNativeChatComposerDrafts(), vi.advanceTimersByTimeAsync(0)),
        () => vi.advanceTimersByTimeAsync(1_000)
      ]) {
        const index = await measure(attempt)
        expect(take()).toMatchObject(whole)
        expect(index.indexAdds).toBe(count)
        expect(index.indexLookups).toBeLessThanOrEqual(count)
        expect(index.entryVisits).toBeGreaterThanOrEqual(count)
        expect(index.entryVisits).toBeLessThanOrEqual(4 * count)
      }
      const rows = refuse(SAVED)
      host.status.mockReset()
      host.status.mockResolvedValue({ state: 'unknown' })
      for (const [index, launch] of launches.entries()) {
        expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
        await vi.waitFor(() =>
          expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.callers.outcome).toBe(
            'unknown'
          )
        )
        // B stays owed by its launch and unshown until its draft's base is read; what is typed
        // meanwhile is the user's own.
        expect(draft(launch.sessionId)).toBe('')
        writeNativeChatDraftCache(scopeOf(launch), `typed ${index}`)
      }
      for (const launch of launches) {
        expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.intent.opening).toBeDefined()
        expect(backend.drafts.get(scopeOf(launch))?.text).toBe('Also run lint')
      }

      const before = localStorage.getItem(JOURNAL) ?? ''
      take()
      let collected = { dirty: 0, unconfirmed: 0, pending: 0 }
      const admission = await measure(async () => {
        collected = collectorWork(() => window.dispatchEvent(new Event('pagehide')))
      })
      const unload = take()
      // Bound, from input and output before any filter: it collects each unconfirmed scope and
      // pending contribution once (U = P = N) and at most N dirty scopes. Over E = 2N existing
      // entries and P = N contributions it visits entries in parse, old-copy/whole index, sizing,
      // kept selection and encoding (5E), the contributions twice (2P), their replaced copies
      // (M <= E) and the output (2F, F <= E + P): within 10E + 6P, with at most one keyed
      // admission lookup per existing and incoming entry (E + P).
      expect(collected).toEqual({ dirty: expect.any(Number), unconfirmed: count, pending: count })
      expect(collected.dirty).toBeLessThanOrEqual(count)
      expect(admission.entryVisits).toBeLessThanOrEqual(10 * (2 * count) + 6 * count)
      expect(admission.indexLookups).toBeLessThanOrEqual(2 * count + count)
      const output = localStorage.getItem(JOURNAL) ?? ''
      const entries: { at: number; run: string }[] = JSON.parse(output)
      // The one retained output, test-owned (generated times and run as written).
      const envelope = JSON.stringify([
        ...corpus,
        // What was typed replaces each chat's unseen saved draft: its whole draft, without the
        // receipt of the return it does not hold yet.
        ...launches.map((_launch, index) => ({
          scopeKey: scopeOf(launches[index]),
          draft: { text: `typed ${index}`, images: [], savedAt: entries[count + index].at },
          at: entries[count + index].at,
          run: entries[count + index].run
        })),
        // And each return, identified, to join it once.
        ...launches.map((launch, index) => ({
          scopeKey: scopeOf(launch),
          at: entries[2 * count + index].at,
          addition: { text: HELD, images: [] },
          custody: {
            handback: { operationId: launch.operationId, clientMessageId: launch.messageId },
            sourcePaths: []
          },
          run: entries[2 * count + index].run
        }))
      ])
      expect(entries).toEqual(JSON.parse(envelope))
      // Bound: one read and parse, one write of exactly that output, and at most two encodings
      // of each entry it holds.
      expect(unload).toMatchObject({
        reads: 1,
        parses: 1,
        parsedChars: before.length,
        writes: 1,
        chars: envelope.length
      })
      expect(unload.encodings).toBeLessThanOrEqual(2 * entries.length)
      take()
      // Nothing changed since: another unload writes nothing.
      window.dispatchEvent(new Event('pagehide'))
      expect(take()).toMatchObject({ reads: 1, writes: 0 })

      // Bound: every chat's own base read comes from the attempt's one snapshot, with no read
      // of the journal; each draft then holds A, what was typed and B, once.
      // In that index each own read is one lookup of its own scope: no build, no entry visited.
      const bases = await measure(async () => {
        reads.resolve()
        await vi.waitFor(() => {
          for (const [index, launch] of launches.entries()) {
            expect(draft(launch.sessionId)).toBe(`typed ${index}\n\n${HELD}`)
          }
        })
      })
      expect(take()).toMatchObject({ reads: 0, parses: 0 })
      expect(bases).toEqual({ entryVisits: 0, indexAdds: 0, indexLookups: count })
      saves.resolve()
      await nativeChatComposerDraftWritesSettled()
      // The older load still reads: it alone excludes the scopes their own reads resolved.
      for (const launch of launches) {
        expect(load.attempt?.excluded.has(scopeOf(launch))).toBe(true)
        expect(scopeInputs.has(scopeOf(launch))).toBe(false)
      }
      // That load lands after and replaces none of them, or fails and owns nothing any more.
      if (outcome === 'lands') {
        landed.resolve()
      } else {
        landed.reject(new Error('second enumeration failed'))
      }
      await hydrateNativeChatComposerDrafts()
      await nativeChatComposerDraftWritesSettled()
      for (const [index, launch] of launches.entries()) {
        expect(draft(launch.sessionId)).toBe(`typed ${index}\n\n${HELD}`)
        expect(readNativeChatComposerDraft(`tab-${index}:pane`).text).toBe(
          outcome === 'lands' ? `unrelated ${index}` : ''
        )
      }

      // Their rows still cannot be saved: each launch keeps its one obligation and its receipt.
      expect(receiptListeners.live).toBe(count)
      for (const launch of launches) {
        expect(nativeChatDraftHasReceipt(scopeOf(launch), receiptOf(launch))).toBe(true)
      }

      // The launches' rows save again: each lets go of its opening, its files and the receipt.
      rows.mockRestore()
      for (const launch of launches) {
        expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
      }
      await vi.waitFor(() => expect(receiptListeners.live).toBe(0))
      await nativeChatComposerDraftWritesSettled()
      const saved: Record<string, unknown>[] = JSON.parse(localStorage.getItem(SAVED) ?? '[]')
      for (const [index, launch] of launches.entries()) {
        expect(
          saved.find((row) => row.sessionId === launch.sessionId)?.firstMessage
        ).toBeUndefined()
        expect(
          getStructuredLaunchStateBySessionId(launch.sessionId)?.intent.opening
        ).toBeUndefined()
        const stored = backend.drafts.get(scopeOf(launch))
        expect(stored?.text).toBe(`typed ${index}\n\n${HELD}`)
        expect(stored).not.toHaveProperty('handbacks')
        expect(stored).not.toHaveProperty('sourcePaths')
      }
      // The unrelated panes' journal stays until a load reads them.
      expect(
        JSON.parse(localStorage.getItem(JOURNAL) ?? '[]').map(
          (entry: { scopeKey: string }) => entry.scopeKey
        )
      ).toEqual(outcome === 'lands' ? [] : corpus.map(({ scopeKey }) => scopeKey))
      expect(host.prepare).toHaveBeenCalledTimes(count)
      expect(host.release).toHaveBeenCalledTimes(count)
      // Nothing of these completed returns is kept while their ordinary drafts live on: no
      // custody, no remembered completion behind their receipts, and nothing of their bases owned,
      // even between failed loads, before any retry has run.
      expect(owned()).toBe(0)
      expect(load.hydrated).toBe(outcome === 'lands')
      const forgotten = { backed: false, incorporated: false, retired: false }
      for (const launch of launches) {
        expect(draftCustody.has(scopeOf(launch))).toBe(false)
        expect(nativeChatDraftReceiptProgress(scopeOf(launch), receiptOf(launch))).toEqual(
          forgotten
        )
      }

      // Closed and deleted, every write drained: nothing of them remains anywhere.
      for (const launch of launches) {
        expect(cancelStructuredAgentLaunch('workspace-1', launch.sessionId)).toBe(true)
      }
      const scopes = new Set(launches.map(scopeOf))
      deleteNativeChatComposerDraftsWhere((scope) => scopes.has(scope))
      await nativeChatComposerDraftWritesSettled()
      for (const launch of launches) {
        expect(getStructuredLaunchStateBySessionId(launch.sessionId)).toBeUndefined()
        expect(backend.drafts.has(scopeOf(launch))).toBe(false)
        expect(draftCustody.has(scopeOf(launch))).toBe(false)
        expect(nativeChatDraftReceiptProgress(scopeOf(launch), receiptOf(launch))).toEqual(
          forgotten
        )
      }
      expect(receiptListeners.live).toBe(0)
      expect(owned()).toBe(0)
      if (outcome === 'fails') {
        // The rest of the schedule fails too and gives up: still nothing owned.
        await vi.advanceTimersByTimeAsync(36_000)
        expect(load).toMatchObject({ hydrated: true, complete: false, attempt: null })
        expect(owned()).toBe(0)
      }
      warn.mockRestore()
    }
  )

  it('lets a large returned draft go once its complete fallback replaces itself within the cap, while the backend still refuses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [launch] = launchesOf(1)
    const scope = scopeOf(launch)
    const parent = deferred<AgentLaunchReleasePhaseStatusResult>()
    await releaseLaunches([launch], () => parent.promise)
    // An ordinary large draft, saved by its own debounced write.
    const typed = 'a'.repeat(80_000)
    writeNativeChatDraftCache(scope, typed)
    await vi.advanceTimersByTimeAsync(250)
    await nativeChatComposerDraftWritesSettled()
    const backend = nativeChatComposerDraftStorage() as ReturnType<
      typeof nativeChatComposerDraftStorage
    > & { drafts: Map<string, { text: string }> }
    expect(backend.drafts.get(scope)?.text === typed).toBe(true)
    const journaled: string[] = []
    const setItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === JOURNAL) {
        journaled.push(value)
      }
      setItem(key, value)
    })
    // From here the draft's backend refuses every write; only the journal can hold the return.
    refuseDraftWrites(true)
    parent.resolve({ state: 'unknown' })
    await vi.waitFor(() =>
      expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.callers.outcome).toBe('unknown')
    )
    // With no backend recovery and no further edit, the launch lets go of its return.
    await vi.waitFor(() => expect(receiptListeners.live).toBe(0))
    await nativeChatComposerDraftWritesSettled()
    const once = `${typed}\n\n${HELD}`
    expect(draft(launch.sessionId) === once).toBe(true)
    // The receipt-bearing complete fallback, then its receipt-free replacement: each fits the
    // whole cap; the two together would not.
    const fallback = journaled.find((value) => value.includes('"handbacks"')) ?? ''
    const replacement = journaled.at(-1) ?? ''
    expect(fallback.length).toBeLessThan(256_000)
    expect(replacement.length).toBeLessThan(256_000)
    expect(fallback.length + replacement.length).toBeGreaterThan(256_000)
    const [entry] = JSON.parse(replacement)
    expect(entry).toMatchObject({ scopeKey: scope })
    expect(entry.draft.text === once).toBe(true)
    expect(entry.draft).not.toHaveProperty('handbacks')
    expect(localStorage.getItem(JOURNAL)).toBe(replacement)
    expect(nativeChatDraftHasReceipt(scope, receiptOf(launch))).toBe(false)
    expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.intent.opening).toBeUndefined()
    const saved: Record<string, unknown>[] = JSON.parse(localStorage.getItem(SAVED) ?? '[]')
    expect(saved.find((row) => row.sessionId === launch.sessionId)?.firstMessage).toBeUndefined()
    // An actual same-O Retry settles with nothing new issued.
    host.status.mockReset()
    host.status.mockResolvedValue({ state: 'unknown' })
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await vi.waitFor(() =>
      expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.callers.outcome).toBe('unknown')
    )
    await nativeChatComposerDraftWritesSettled()
    expect(draft(launch.sessionId) === once).toBe(true)
    expect(receiptListeners.live).toBe(0)
    expect(host.prepare).toHaveBeenCalledOnce()
    expect(host.release).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it.each(['an ordinary paste', 'an addition then edited'] as const)(
    'keeps the last identified backup through an unload of %s too large for the journal, then recovers',
    async (input) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const [launch] = launchesOf(1)
      const scope = scopeOf(launch)
      await releaseLaunches([launch], () => new Promise(() => {}))
      const backend = nativeChatComposerDraftStorage() as ReturnType<
        typeof nativeChatComposerDraftStorage
      > & { drafts: Map<string, { text: string; handbacks?: unknown }> }
      // A restart whose load and the chat's own read are held; the launch's row cannot be saved.
      restartRenderer()
      const loadAll = backend.loadAll.bind(backend)
      const landed = Promise.withResolvers<void>()
      vi.spyOn(backend, 'loadAll').mockImplementation(async () => {
        const drafts = await loadAll()
        await landed.promise
        return drafts
      })
      const reads = Promise.withResolvers<void>()
      holdDraftSaves(new Set([scope]), () => reads.promise)
      const rows = refuse(SAVED)
      void hydrateNativeChatComposerDrafts()
      host.status.mockReset()
      host.status.mockResolvedValue({ state: 'unknown' })
      expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
      await vi.waitFor(() =>
        expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.callers.outcome).toBe(
          'unknown'
        )
      )
      // A stored, B owed and unshown, and B's identified backup written.
      expect(draft(launch.sessionId)).toBe('')
      expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.intent.opening).toBeDefined()
      expect(backend.drafts.get(scope)?.text).toBe('Also run lint')
      const backup = localStorage.getItem(JOURNAL)
      expect(JSON.parse(backup ?? '[]')).toEqual([
        expect.objectContaining({
          scopeKey: scope,
          addition: expect.objectContaining({ text: HELD }),
          custody: { handback: receiptOf(launch), sourcePaths: [] }
        })
      ])
      const pasted = 'x'.repeat(410_000)
      if (input === 'an ordinary paste') {
        // Ordinary typing replaces the unseen saved draft; its whole copy exceeds the whole-draft
        // cap, while the return's backup is replaced by the same identified return.
        writeNativeChatDraftCache(scope, pasted)
        window.dispatchEvent(new Event('pagehide'))
        expect(JSON.parse(localStorage.getItem(JOURNAL) ?? '[]')).toEqual([
          expect.objectContaining({
            scopeKey: scope,
            addition: expect.objectContaining({ text: HELD }),
            custody: { handback: receiptOf(launch), sourcePaths: [] }
          })
        ])
      } else {
        // An addition over the unread draft, then edited: its edited view joins the return as one
        // identified addition, which no longer fits the additions' cap. The unload keeps both the
        // return's backup and the addition's own, exactly.
        appendNativeChatDraftCache(scope, pasted)
        const appended = localStorage.getItem(JOURNAL)
        writeNativeChatDraftCache(scope, `${pasted} typed`)
        window.dispatchEvent(new Event('pagehide'))
        expect(localStorage.getItem(JOURNAL)).toBe(appended)
      }
      expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.intent.opening).toBeDefined()

      // The read, the load and the row's save recover: A, the paste and B, once; then no debt.
      rows.mockRestore()
      reads.resolve()
      landed.resolve()
      await hydrateNativeChatComposerDrafts()
      const once =
        input === 'an ordinary paste'
          ? `${pasted}\n\n${HELD}`
          : `Also run lint\n\n${pasted} typed\n\n${HELD}`
      await vi.waitFor(() => expect(draft(launch.sessionId)).toBe(once))
      expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
      await vi.waitFor(() => expect(receiptListeners.live).toBe(0))
      await nativeChatComposerDraftWritesSettled()
      expect(draft(launch.sessionId)).toBe(once)
      expect(backend.drafts.get(scope)?.text).toBe(once)
      expect(backend.drafts.get(scope)).not.toHaveProperty('handbacks')
      expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.intent.opening).toBeUndefined()
      expect(localStorage.getItem(JOURNAL)).toBeNull()
      expect(host.prepare).toHaveBeenCalledOnce()
      expect(host.release).toHaveBeenCalledOnce()
      warn.mockRestore()
    }
  )
})
