// @vitest-environment happy-dom
// Many held launches at once, each with its own chat: what Close and an unload cost while their
// returns wait on their drafts, through the launches' own Prepare, Release, Retry and Close.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
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
      void hydrateNativeChatComposerDrafts()
      await vi.advanceTimersByTimeAsync(0)
      // Bound: an attempt reads and parses the whole journal once, at its read boundary, and a
      // new attempt takes its own.
      const whole = { reads: 1, parses: 1, parsedChars: JSON.stringify(corpus).length }
      expect(take()).toMatchObject(whole)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(take()).toMatchObject(whole)
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
      reads.resolve()
      await vi.waitFor(() => {
        for (const [index, launch] of launches.entries()) {
          expect(draft(launch.sessionId)).toBe(`Also run lint\n\ntyped ${index}\n\n${HELD}`)
        }
      })
      expect(take()).toMatchObject({ reads: 0, parses: 0 })
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
      warn.mockRestore()
    }
  )
})
