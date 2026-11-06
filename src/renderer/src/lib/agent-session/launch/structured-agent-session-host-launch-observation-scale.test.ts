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
import {
  nativeChatDraftHasReceipt,
  nativeChatDraftReceiptProgress
} from '@/components/native-chat/native-chat-composer-draft-handback'
import { writeNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
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
    const isEntry = (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { scopeKey?: unknown }).scopeKey === 'string' &&
      typeof (value as { at?: unknown }).at === 'number' &&
      ('draft' in value || 'addition' in value)
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

  it.each([3, 30])(
    'unloads %i returns waiting on their unread drafts in one journal write, read from one snapshot',
    async (count) => {
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
      window.dispatchEvent(new Event('pagehide'))
      const unload = take()
      const output = localStorage.getItem(JOURNAL) ?? ''
      const entries: { at: number; run: string }[] = JSON.parse(output)
      // The one retained output: the unrelated journal and one identified addition per chat,
      // holding what was typed and its return (generated time and run as written).
      const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
      const envelope = JSON.stringify([
        ...corpus,
        ...launches.map((launch, index) => ({
          scopeKey: scopeOf(launch),
          at: entries[count + index].at,
          addition: {
            text: `typed ${index}\n\n${HELD}`,
            document: {
              type: 'doc',
              content: [paragraph(`typed ${index}`), { type: 'paragraph' }, paragraph(HELD)]
            },
            images: [],
            pastedTextFiles: {}
          },
          custody: {
            handback: { operationId: launch.operationId, clientMessageId: launch.messageId },
            sourcePaths: []
          },
          run: entries[count + index].run
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
            expect(draft(launch.sessionId)).toBe(`Also run lint\n\ntyped ${index}\n\n${HELD}`)
          }
        })
      })
      expect(take()).toMatchObject({ reads: 0, parses: 0 })
      expect(bases).toEqual({ entryVisits: 0, indexAdds: 0, indexLookups: count })
      saves.resolve()
      await nativeChatComposerDraftWritesSettled()
      // The older load lands after: it replaces none of them, and replays the unrelated panes.
      landed.resolve()
      await hydrateNativeChatComposerDrafts()
      await nativeChatComposerDraftWritesSettled()
      for (const [index, launch] of launches.entries()) {
        expect(draft(launch.sessionId)).toBe(`Also run lint\n\ntyped ${index}\n\n${HELD}`)
        expect(readNativeChatComposerDraft(`tab-${index}:pane`).text).toBe(`unrelated ${index}`)
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
        expect(stored?.text).toBe(`Also run lint\n\ntyped ${index}\n\n${HELD}`)
        expect(stored).not.toHaveProperty('handbacks')
        expect(stored).not.toHaveProperty('sourcePaths')
      }
      expect(localStorage.getItem(JOURNAL)).toBeNull()
      expect(host.prepare).toHaveBeenCalledTimes(count)
      expect(host.release).toHaveBeenCalledTimes(count)
      // Nothing of these completed returns is kept while their ordinary drafts live on: no
      // custody, and no remembered completion behind their receipts.
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
      warn.mockRestore()
    }
  )

  it('keeps the last identified backup when an unload’s replacement no longer fits, then recovers', async () => {
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
      expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.callers.outcome).toBe('unknown')
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
    // An ordinary paste whose coalesced replacement no longer fits the additions' cap.
    const pasted = 'x'.repeat(410_000)
    writeNativeChatDraftCache(scope, pasted)
    window.dispatchEvent(new Event('pagehide'))
    // The one unload keeps the backup it could not replace, exactly.
    expect(localStorage.getItem(JOURNAL)).toBe(backup)
    expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.intent.opening).toBeDefined()

    // The read, the load and the row's save recover: A, the paste and B, once; then no debt.
    rows.mockRestore()
    reads.resolve()
    landed.resolve()
    await hydrateNativeChatComposerDrafts()
    const once = `Also run lint\n\n${pasted}\n\n${HELD}`
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
  })
})
