// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DraftStore from './native-chat-composer-draft-store'
import type * as DraftHandback from './native-chat-composer-draft-handback'
import type * as DraftCache from './native-chat-draft-cache'
import type * as DraftMove from './native-chat-composer-draft-move'
import type * as Staging from './native-chat-draft-attachment-staging'
import type * as DraftMemory from './native-chat-composer-draft-memory'
import type * as DraftInput from './native-chat-composer-draft-input'
import {
  createMemoryNativeChatComposerDraftStorage,
  type NativeChatComposerDraftStorage
} from './native-chat-composer-draft-storage'

type Renderer = {
  store: typeof DraftStore
  handback: typeof DraftHandback
  drafts: typeof DraftCache
  move: typeof DraftMove
  staging: typeof Staging
  memory: typeof DraftMemory
  input: typeof DraftInput
}

const JOURNAL_KEY = 'orca:nativeChatComposerDraftJournal:v1'
const SCOPE = 'agent-session:s1'
const A = 'Also run lint'
const B = 'Inspect the failing test and fix it'
const RECEIPT = { operationId: 'op-1', clientMessageId: 'msg-1', sessionId: 's1' }
const RECEIPT_2 = { operationId: 'op-2', clientMessageId: 'msg-2' }
const IMAGE = { id: 'returned-msg-1-0', path: '/client/durable.png' }
const B_INPUT = { text: `${B} [Image #1]`, images: [IMAGE] }
const SOURCE_PATHS = [IMAGE.path]

let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
const loaded: Renderer[] = []
let journalRefuses = false
let journalAttempts = 0
let backendAttempts = 0

/** A fresh renderer: draft memory is gone; the backend and the localStorage journal are not. */
async function reload(
  options: { hydrate?: boolean; storage?: Partial<NativeChatComposerDraftStorage> } = {}
): Promise<Renderer> {
  vi.resetModules()
  const storageModule = await import('./native-chat-composer-draft-storage')
  const counted = {
    ...storage,
    write: (...args: Parameters<typeof storage.write>) => {
      backendAttempts += 1
      return storage.write(...args)
    },
    update: (...args: Parameters<typeof storage.update>) => {
      backendAttempts += 1
      return storage.update(...args)
    },
    ...options.storage
  }
  storageModule.setNativeChatComposerDraftStorageForTests(counted)
  const instance = {
    store: await import('./native-chat-composer-draft-store'),
    handback: await import('./native-chat-composer-draft-handback'),
    drafts: await import('./native-chat-draft-cache'),
    move: await import('./native-chat-composer-draft-move'),
    staging: await import('./native-chat-draft-attachment-staging'),
    memory: await import('./native-chat-composer-draft-memory'),
    input: await import('./native-chat-composer-draft-input')
  }
  loaded.push(instance)
  if (options.hydrate !== false) {
    await instance.store.hydrateNativeChatComposerDrafts()
  }
  return instance
}

function text(tab: Renderer, scope = SCOPE): string {
  return tab.store.readNativeChatComposerDraft(scope).text
}

/** The receipt's next commit result, through the one removable subscription. */
function settled(tab: Renderer, scope: string, receipt: typeof RECEIPT): Promise<boolean> {
  return new Promise((resolve) => {
    let first = true
    const stop = tab.handback.subscribeNativeChatDraftReceiptProgress(
      scope,
      receipt,
      (progress) => {
        // The registration's own report comes first; the next commit result settles it.
        if (first && !progress.backed) {
          first = false
          return
        }
        stop()
        resolve(progress.backed)
      }
    )
  })
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const realSetItem = Storage.prototype.setItem
beforeEach(() => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
  journalRefuses = false
  journalAttempts = 0
  backendAttempts = 0
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string
  ) {
    if (key === JOURNAL_KEY) {
      journalAttempts += 1
      if (journalRefuses) {
        throw new DOMException('full', 'QuotaExceededError')
      }
    }
    realSetItem.call(this, key, value)
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const instance of loaded.splice(0)) {
    instance.store.clearNativeChatComposerDraftsForTests()
  }
})

describe('an identified hand-back in the composer draft', () => {
  it('lands once across refused storage, later typing, recovery and a second request', async () => {
    const tab = await reload()
    tab.drafts.writeNativeChatDraftCache(SCOPE, A)
    await tab.store.nativeChatComposerDraftWritesSettled()
    storage.refuseWrites = true
    journalRefuses = true
    backendAttempts = 0
    journalAttempts = 0

    expect(
      tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, B_INPUT, SOURCE_PATHS)
    ).toEqual({ adopted: true })
    expect(text(tab)).toBe(`${A}\n\n${B} [Image #1]`)
    expect(await settled(tab, SCOPE, RECEIPT)).toBe(false)
    expect(tab.handback.nativeChatDraftReceiptProgress(SCOPE, RECEIPT).backed).toBe(false)

    tab.drafts.writeNativeChatDraftCache(SCOPE, `${text(tab)}\nAnd run tests`)
    storage.refuseWrites = false
    journalRefuses = false
    // The source asks again: the receipt, not the text, says the draft already holds B.
    expect(
      tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, B_INPUT, SOURCE_PATHS)
    ).toEqual({ adopted: false })
    expect(await settled(tab, SCOPE, RECEIPT)).toBe(true)
    const expected = `${A}\n\n${B} [Image #1]\nAnd run tests`
    expect(text(tab)).toBe(expected)
    expect(storage.drafts.get(SCOPE)).toMatchObject({
      text: expected,
      handbacks: [RECEIPT],
      sourcePaths: SOURCE_PATHS
    })
    // Bound from the required transitions: the adoption's immediate write and the one retry of the
    // current draft after recovery (the first settle awaits the adoption's own refused attempt);
    // the journal gets the adoption's identified addition and one copy per refused backend
    // attempt. Launch-journal writes are separate and not in these counts.
    expect(backendAttempts).toBe(2)
    expect(journalAttempts).toBe(2)

    const cold = await reload()
    expect(text(cold)).toBe(expected)
    expect(
      cold.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, B_INPUT, SOURCE_PATHS)
    ).toEqual({ adopted: false })
    expect(occurrences(text(cold), B)).toBe(1)
  })

  it('keeps an intentionally equal independent draft beside the returned input', async () => {
    const tab = await reload()
    tab.drafts.writeNativeChatDraftCache(SCOPE, B)
    tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
    expect(text(tab)).toBe(`${B}\n\n${B}`)
    expect(await settled(tab, SCOPE, RECEIPT)).toBe(true)
    expect(text(await reload())).toBe(`${B}\n\n${B}`)
  })

  it.each([
    ['backend only', false, true, true],
    ['journal only', true, false, true],
    ['neither', true, true, false]
  ])(
    'after a cold reload with the %s succeeding, adopts exactly once',
    async (_cut, backendRefuses, journalFails, proven) => {
      // A legacy record without receipt or provenance is the base.
      storage.drafts.set(SCOPE, { text: A, images: [], savedAt: 1 })
      const tab = await reload()
      expect(tab.handback.nativeChatDraftSourcePaths(SCOPE)).toEqual([])
      storage.refuseWrites = backendRefuses
      journalRefuses = journalFails
      tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, B_INPUT, SOURCE_PATHS)
      expect(await settled(tab, SCOPE, RECEIPT)).toBe(proven)
      tab.store.clearNativeChatComposerDraftsForTests()
      storage.refuseWrites = false
      journalRefuses = false

      const cold = await reload()
      expect(cold.handback.nativeChatDraftHasReceipt(SCOPE, RECEIPT)).toBe(proven)
      expect(
        cold.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, B_INPUT, SOURCE_PATHS)
          .adopted
      ).toBe(!proven)
      expect(text(cold)).toBe(`${A}\n\n${B} [Image #1]`)
      // Provenance re-claims the client file, so a Send prepares it rather than sending its path.
      expect(cold.handback.nativeChatDraftSourcePaths(SCOPE)).toEqual(SOURCE_PATHS)
      // A live adoption leaves the claim to the launch's own lease.
      expect(cold.staging.hasNativeChatStagedFiles(SCOPE)).toBe(proven)
    }
  )

  it('keeps a cleared returned draft as a receipt only, which neither shows nor resurrects', async () => {
    const tab = await reload()
    tab.drafts.writeNativeChatDraftCache(SCOPE, A)
    await tab.store.nativeChatComposerDraftWritesSettled()
    storage.refuseWrites = true
    journalRefuses = true
    tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, B_INPUT, SOURCE_PATHS)
    tab.drafts.writeNativeChatDraftCache(SCOPE, '')
    tab.store.updateNativeChatComposerDraft(SCOPE, { images: [] }, 'immediate')
    expect(tab.store.readNativeChatComposerDraft(SCOPE)).toMatchObject({ text: '', images: [] })
    expect(tab.store.isNativeChatComposerDraftUnsaved(SCOPE)).toBe(false)
    expect(tab.handback.nativeChatDraftSourcePaths(SCOPE)).toEqual([])
    await tab.store.nativeChatComposerDraftWritesSettled()
    storage.refuseWrites = false
    journalRefuses = false
    // The next attempt saves the receipt-only disposition.
    expect(await settled(tab, SCOPE, RECEIPT)).toBe(true)
    expect(await tab.store.nativeChatComposerDraftWriteSettled(SCOPE)).toBe(true)
    expect(storage.drafts.get(SCOPE)).toMatchObject({ text: '', images: [], handbacks: [RECEIPT] })

    const cold = await reload()
    expect(
      cold.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, B_INPUT, SOURCE_PATHS)
    ).toEqual({ adopted: false })
    expect(text(cold)).toBe('')
    cold.handback.retireNativeChatDraftReceipt(SCOPE, RECEIPT)
    await cold.store.nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.has(SCOPE)).toBe(false)
    expect(localStorage.getItem(JOURNAL_KEY)).toBeNull()
  })

  it('keeps the only journaled proof when a later draft no longer fits the journal', async () => {
    const tab = await reload()
    tab.drafts.writeNativeChatDraftCache(SCOPE, A)
    await tab.store.nativeChatComposerDraftWritesSettled()
    storage.refuseWrites = true
    journalRefuses = true
    tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, B_INPUT, SOURCE_PATHS)
    journalRefuses = false
    // The next refused backend attempt journals the current draft with its receipt.
    expect(await settled(tab, SCOPE, RECEIPT)).toBe(true)
    tab.drafts.writeNativeChatDraftCache(SCOPE, 'x'.repeat(300_000))
    // Another draft that does fit is journaled in the same write.
    tab.drafts.writeNativeChatDraftCache('tab-1:pane', 'typed elsewhere')
    tab.store.flushNativeChatComposerDrafts()
    await tab.store.nativeChatComposerDraftWritesSettled()
    window.dispatchEvent(new Event('pagehide'))
    tab.store.clearNativeChatComposerDraftsForTests()
    storage.refuseWrites = false

    const cold = await reload()
    expect(cold.handback.nativeChatDraftHasReceipt(SCOPE, RECEIPT)).toBe(true)
    expect(text(cold)).toBe(`${A}\n\n${B} [Image #1]`)
    expect(text(cold, 'tab-1:pane')).toBe('typed elsewhere')
  })

  it('moves receipts and provenance with the draft, and another tab adopts them', async () => {
    const tab = await reload()
    const other = await reload()
    tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, B_INPUT, SOURCE_PATHS)
    tab.move.moveNativeChatComposerDraft(SCOPE, 'agent-session:s2')
    expect(tab.handback.nativeChatDraftHasReceipt(SCOPE, RECEIPT)).toBe(false)
    expect(tab.handback.nativeChatDraftHasReceipt('agent-session:s2', RECEIPT)).toBe(true)
    expect(tab.handback.nativeChatDraftSourcePaths('agent-session:s2')).toEqual(SOURCE_PATHS)
    expect(await settled(tab, 'agent-session:s2', RECEIPT)).toBe(true)
    await vi.waitFor(() => expect(storage.drafts.has(SCOPE)).toBe(false))
    await vi.waitFor(() =>
      expect(other.handback.nativeChatDraftHasReceipt('agent-session:s2', RECEIPT)).toBe(true)
    )
    expect(other.handback.nativeChatDraftSourcePaths('agent-session:s2')).toEqual(SOURCE_PATHS)
    expect(other.store.readNativeChatComposerDraft('agent-session:s2').images).toEqual([IMAGE])
  })

  it('turns a returned browser file whose bytes did not survive into one to attach again', async () => {
    const token = 'orca-browser-file:0000/shot.png'
    storage.drafts.set(SCOPE, {
      text: `${B} [Image #1]`,
      images: [{ id: 'returned-msg-1-0', path: token }],
      savedAt: 1,
      handbacks: [RECEIPT],
      sourcePaths: [token]
    })
    const cold = await reload()
    expect(cold.store.readNativeChatComposerDraft(SCOPE).images).toEqual([
      { id: 'returned-msg-1-0', path: '', unavailableName: 'shot.png' }
    ])
    expect(cold.handback.nativeChatDraftSourcePaths(SCOPE)).toEqual([])
    expect(cold.staging.hasNativeChatStagedFiles(SCOPE)).toBe(false)
  })
})

describe('an identified hand-back before its draft’s saved base is known', () => {
  /** A renderer whose draft load stays open until `land`. */
  async function loading() {
    let land: () => void = () => {}
    const tab = await reload({
      hydrate: false,
      storage: {
        loadAll: () => {
          const snapshot = new Map(storage.drafts)
          return new Promise((resolve) => (land = () => resolve(snapshot)))
        }
      }
    })
    const load = tab.store.hydrateNativeChatComposerDrafts()
    return { tab, land: async () => (land(), await load) }
  }

  beforeEach(() => {
    storage.drafts.set(SCOPE, { text: A, images: [], savedAt: 1 })
  })

  it.each([
    ['nothing given back', 'none', A],
    ['the input given back', 'adopt', `${A}\n\n${B}`],
    ['the input given back and its source retired', 'retire', `${A}\n\n${B}`]
  ] as const)(
    'keeps stored A with %s before the load lands, whether or not the backend refuses',
    async (_case, mode, expected) => {
      for (const refuse of [false, true]) {
        storage.drafts.set(SCOPE, { text: A, images: [], savedAt: 1 })
        const { tab, land } = await loading()
        storage.refuseWrites = refuse
        if (mode !== 'none') {
          tab.handback.adoptIdentifiedNativeChatDraftInput(
            SCOPE,
            RECEIPT,
            { text: B, images: [] },
            []
          )
        }
        // Retired as soon as the journal proves the adoption: a metadata-only change.
        if (mode === 'retire') {
          expect(tab.handback.nativeChatDraftReceiptProgress(SCOPE, RECEIPT).backed).toBe(true)
          tab.handback.retireNativeChatDraftReceipt(SCOPE, RECEIPT)
        }
        storage.refuseWrites = false
        await land()
        await tab.store.nativeChatComposerDraftWritesSettled()
        expect(text(tab)).toBe(expected)
        const cold = await reload()
        expect(text(cold)).toBe(expected)
        expect(cold.handback.nativeChatDraftHasReceipt(SCOPE, RECEIPT)).toBe(mode === 'adopt')
        localStorage.clear()
      }
    }
  )

  it('keeps what was typed before its base read, with the return beside it, live and after a crash', async () => {
    for (const crash of [false, true]) {
      storage.drafts.set(SCOPE, { text: A, images: [], savedAt: 1 })
      let read: () => void = () => {}
      const { tab, land } = await loading()
      // The scope's own read is held too: neither A nor whether B was adopted is known yet.
      const held = new Promise<void>((resolve) => (read = resolve))
      const update = storage.update
      storage.update = async (...args) => (await held, update(...args))
      tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
      expect(text(tab)).toBe('')
      // Ordinary typing replaces the unseen saved draft; the identified return still joins it.
      tab.drafts.writeNativeChatDraftCache(SCOPE, 'typed meanwhile')
      if (crash) {
        window.dispatchEvent(new Event('pagehide'))
        tab.store.clearNativeChatComposerDraftsForTests()
        storage.update = update
        expect(text(await reload())).toBe(`typed meanwhile\n\n${B}`)
      } else {
        read()
        await vi.waitFor(() => expect(text(tab)).toBe(`typed meanwhile\n\n${B}`))
        await land()
        await tab.store.nativeChatComposerDraftWritesSettled()
        storage.update = update
        expect(text(tab)).toBe(`typed meanwhile\n\n${B}`)
        expect(storage.drafts.get(SCOPE)?.text).toBe(`typed meanwhile\n\n${B}`)
      }
      localStorage.clear()
    }
  })

  it('keeps a base its own read resolved through failed loads without any fence, and joins a later return once', async () => {
    vi.useFakeTimers()
    try {
      const tab = await reload({
        hydrate: false,
        storage: { loadAll: () => Promise.reject(new Error('database busy')) }
      })
      tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
      await tab.store.nativeChatComposerDraftWritesSettled()
      // Its own read put B beside stored A while the load fails: the draft is complete, and no
      // failed load owns anything of it.
      expect(text(tab)).toBe(`${A}\n\n${B}`)
      expect(tab.input.scopeInputs.has(SCOPE)).toBe(false)
      expect(tab.memory.load.attempt).toBeNull()
      // The retries fail too, and loading gives up: still nothing owned, nothing lost.
      await vi.advanceTimersByTimeAsync(36_000)
      expect(tab.memory.load).toMatchObject({ hydrated: true, complete: false, attempt: null })
      // Its live draft is its resolved base: another return joins it once.
      const next = 'Then run the build'
      tab.handback.adoptIdentifiedNativeChatDraftInput(
        SCOPE,
        RECEIPT_2,
        { text: next, images: [] },
        []
      )
      expect(text(tab)).toBe(`${A}\n\n${B}\n\n${next}`)
      await tab.store.nativeChatComposerDraftWritesSettled()
      expect(storage.drafts.get(SCOPE)?.text).toBe(`${A}\n\n${B}\n\n${next}`)
    } finally {
      vi.useRealTimers()
    }
  })

  const N = 'Note from the file mention'

  it('resolves an addition before a failing load at its own read, once, and a later return joins it', async () => {
    vi.useFakeTimers()
    try {
      const tab = await reload({
        hydrate: false,
        storage: { loadAll: () => Promise.reject(new Error('database busy')) }
      })
      tab.store.appendToNativeChatComposerDraft(SCOPE, { text: N })
      await tab.store.nativeChatComposerDraftWritesSettled()
      // Its own write read stored A: the complete result is what the composer shows and saves.
      expect(text(tab)).toBe(`${A}\n\n${N}`)
      expect(storage.drafts.get(SCOPE)?.text).toBe(`${A}\n\n${N}`)
      expect(tab.input.scopeInputs.has(SCOPE)).toBe(false)
      await vi.advanceTimersByTimeAsync(36_000)
      expect(tab.memory.load).toMatchObject({ hydrated: true, complete: false, attempt: null })
      tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
      expect(text(tab)).toBe(`${A}\n\n${N}\n\n${B}`)
      await tab.store.nativeChatComposerDraftWritesSettled()
      expect(storage.drafts.get(SCOPE)?.text).toBe(`${A}\n\n${N}\n\n${B}`)
    } finally {
      vi.useRealTimers()
    }
    expect(text(await reload())).toBe(`${A}\n\n${N}\n\n${B}`)
  })

  it('publishes a rich addition over a slow first load once, and the late load replaces none of it', async () => {
    const { tab, land } = await loading()
    const paste = '0b9e7b62-1b0c-4a7a-9c3e-2f6a1d2c3b4a'
    const added = `${N} [Pasted text](orca-paste:${paste}) [Image #1]`
    const skill = {
      type: 'nativeChatSkill',
      attrs: { token: '$review', path: '/skills/review/SKILL.md' }
    }
    tab.store.appendToNativeChatComposerDraft(SCOPE, {
      text: added,
      document: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `${added} ` }, skill] }]
      },
      pastedTextFiles: { [paste]: '/client/paste.txt' },
      images: [IMAGE]
    })
    await tab.store.nativeChatComposerDraftWritesSettled()
    tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
    await tab.store.nativeChatComposerDraftWritesSettled()
    const once = `${A}\n\n${added}\n\n${B}`
    expect(text(tab)).toBe(once)
    // The load began reading before both writes: it lands and replaces neither.
    await land()
    await tab.store.nativeChatComposerDraftWritesSettled()
    expect(text(tab)).toBe(once)
    const cold = await reload()
    const restored = cold.store.readNativeChatComposerDraft(SCOPE)
    expect(restored).toMatchObject({
      text: once,
      images: [IMAGE],
      pastedTextFiles: { [paste]: '/client/paste.txt' }
    })
    expect(JSON.stringify(restored.document).split('/skills/review/SKILL.md')).toHaveLength(2)
    expect(storage.drafts.get(SCOPE)?.text).toBe(once)
  })

  it.each(['an edit of what it showed', 'a Send of it', 'a Send another edit beat'] as const)(
    'resolves an addition whose read is held with %s, once and without bringing back what it replaced',
    async (change) => {
      const { tab, land } = await loading()
      let read: () => void = () => {}
      const held = new Promise<void>((resolve) => (read = resolve))
      const update = storage.update
      storage.update = async (...args) => (await held, update(...args))
      tab.store.appendToNativeChatComposerDraft(SCOPE, { text: N })
      expect(text(tab)).toBe(N)
      let submitted: string | undefined
      if (change === 'an edit of what it showed') {
        tab.drafts.writeNativeChatDraftCache(SCOPE, `${N} typed`)
      } else if (change === 'a Send another edit beat') {
        // The Send's clear finds newer input: nothing is consumed, nothing changes authority.
        tab.drafts.writeNativeChatDraftCache(SCOPE, `${N} typed`)
        expect(
          tab.drafts.clearNativeChatComposerDraftIfUnchanged(SCOPE, { text: N, images: [] })
        ).toBe(false)
      } else {
        const submission = tab.store.captureNativeChatComposerSubmission(SCOPE)
        expect(
          tab.drafts.clearNativeChatComposerDraftIfUnchanged(SCOPE, { text: N, images: [] })
        ).toBe(true)
        submitted = submission?.draft?.text
      }
      read()
      await tab.store.nativeChatComposerDraftWritesSettled()
      storage.update = update
      // The edit resolves A plus what it shows now; the Send replaced what was there, A included.
      const expected = change === 'a Send of it' ? '' : `${A}\n\n${N} typed`
      expect(text(tab)).toBe(expected)
      expect(storage.drafts.get(SCOPE)?.text ?? '').toBe(expected)
      expect(tab.input.scopeInputs.has(SCOPE)).toBe(false)
      if (submitted !== undefined) {
        expect(submitted).toBe(N)
      }
      // The load that read A before either lands late and brings nothing back.
      await land()
      await tab.store.nativeChatComposerDraftWritesSettled()
      expect(text(tab)).toBe(expected)
      expect(text(await reload())).toBe(expected)
    }
  )

  it('keeps a value its own read resolved but storage refused through a failed load and the next', async () => {
    let failFirst: (error: Error) => void = () => {}
    let loads = 0
    let commitFails = true
    vi.useFakeTimers()
    try {
      const tab = await reload({
        hydrate: false,
        storage: {
          loadAll: () =>
            ++loads === 1
              ? new Promise((_resolve, reject) => (failFirst = reject))
              : Promise.resolve(new Map(storage.drafts)),
          // The transaction reads and runs, then its commit fails: nothing is stored.
          update: (scopeKey, apply) => {
            const next = apply(storage.drafts.get(scopeKey))
            if (commitFails) {
              return Promise.reject(new DOMException('refused', 'QuotaExceededError'))
            }
            if (next) {
              storage.drafts.set(scopeKey, next)
            } else {
              storage.drafts.delete(scopeKey)
            }
            return Promise.resolve()
          }
        }
      })
      tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
      await vi.advanceTimersByTimeAsync(10)
      expect(text(tab)).toBe(`${A}\n\n${B}`)
      failFirst(new Error('database busy'))
      await vi.advanceTimersByTimeAsync(1_000)
      // The next load read stored A; the refused value is still current work, so it stays.
      expect(tab.memory.load.complete).toBe(true)
      expect(text(tab)).toBe(`${A}\n\n${B}`)
      expect(tab.handback.nativeChatDraftHasReceipt(SCOPE, RECEIPT)).toBe(true)
      expect(storage.drafts.get(SCOPE)?.text).toBe(A)
      // Its existing wake saves it once storage accepts.
      commitFails = false
      tab.handback.requestNativeChatDraftReceiptCommit(SCOPE, RECEIPT)
      await tab.store.nativeChatComposerDraftWritesSettled()
      expect(storage.drafts.get(SCOPE)?.text).toBe(`${A}\n\n${B}`)
    } finally {
      vi.useRealTimers()
    }
  })

  it("lets a replaced load's late result or failure publish nothing, and keeps the current one's", async () => {
    const reads: {
      resolve: (drafts: Map<string, unknown>) => void
      reject: (error: Error) => void
    }[] = []
    const tab = await reload({
      hydrate: false,
      storage: {
        loadAll: () =>
          new Promise((resolve, reject) => {
            const snapshot = new Map<string, unknown>(storage.drafts)
            reads.push({ resolve: () => resolve(snapshot), reject })
          })
      }
    })
    const storageModule = await import('./native-chat-composer-draft-storage')
    const backend = storageModule.nativeChatComposerDraftStorage()
    const restart = () => {
      tab.store.clearNativeChatComposerDraftsForTests()
      storageModule.setNativeChatComposerDraftStorageForTests(backend)
      void tab.store.hydrateNativeChatComposerDrafts()
    }
    void tab.store.hydrateNativeChatComposerDrafts()
    restart()
    restart()
    const current = tab.memory.load.attempt
    tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
    await tab.store.nativeChatComposerDraftWritesSettled()
    expect(text(tab)).toBe(`${A}\n\n${B}`)
    // The two superseded loads finish late: one with what it read before B, one failing.
    reads[0].resolve(new Map())
    reads[1].reject(new Error('database busy'))
    await Promise.resolve()
    await tab.store.nativeChatComposerDraftWritesSettled()
    expect(tab.memory.load.attempt).toBe(current)
    expect(current?.excluded.has(SCOPE)).toBe(true)
    expect(text(tab)).toBe(`${A}\n\n${B}`)
    // The current load read before B too; it lands and replaces nothing its scope's read resolved.
    reads[2].resolve(new Map())
    await tab.store.hydrateNativeChatComposerDrafts()
    await tab.store.nativeChatComposerDraftWritesSettled()
    expect(tab.memory.load).toMatchObject({ complete: true, attempt: null })
    expect(text(tab)).toBe(`${A}\n\n${B}`)
  })

  it('never brings back B the user removed, nor loses A, when the late load or replay lands', async () => {
    const { tab, land } = await loading()
    tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, B_INPUT, SOURCE_PATHS)
    expect(text(tab)).toBe(`${A}\n\n${B} [Image #1]`)
    // The user removes the returned input: the receipt stays, its provenance goes.
    tab.store.updateNativeChatComposerDraft(SCOPE, { text: A, images: [] }, 'immediate')
    expect(tab.handback.nativeChatDraftSourcePaths(SCOPE)).toEqual([])
    await land()
    await tab.store.nativeChatComposerDraftWritesSettled()
    expect(text(tab)).toBe(A)
    expect(storage.drafts.get(SCOPE)).toMatchObject({ text: A, handbacks: [RECEIPT] })
    // The identified addition went with the commit that holds its disposition.
    expect(localStorage.getItem(JOURNAL_KEY) ?? '').not.toContain(B)
    const cold = await reload()
    expect(text(cold)).toBe(A)
    expect(cold.handback.nativeChatDraftHasReceipt(SCOPE, RECEIPT)).toBe(true)
  })

  it('retires only the receipt, leaving content another renderer just committed', async () => {
    const tab = await reload()
    tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
    await tab.store.nativeChatComposerDraftWritesSettled()
    const other = await reload()
    other.store.updateNativeChatComposerDraft(SCOPE, { text: 'newer elsewhere' }, 'immediate')
    // Retired before this renderer has heard of the other one's commit.
    tab.handback.retireNativeChatDraftReceipt(SCOPE, RECEIPT)
    await tab.store.nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.get(SCOPE)).toEqual(expect.objectContaining({ text: 'newer elsewhere' }))
    expect(storage.drafts.get(SCOPE)?.handbacks).toBeUndefined()
  })

  it.each([3, 30])(
    'observes one held commit without a reaction per %i subscriptions, none left once removed',
    async (count) => {
      const tab = await reload()
      journalRefuses = true
      let commit: () => void = () => {}
      let reactions = 0
      const update = storage.update
      storage.update = (...args) => {
        const held = new Promise<void>((resolve) => (commit = resolve)).then(() => update(...args))
        const then = held.then.bind(held)
        vi.spyOn(held, 'then').mockImplementation((...callbacks) => {
          reactions += 1
          return then(...callbacks)
        })
        return held
      }
      tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
      const heard: boolean[] = []
      for (let index = 0; index < count; index++) {
        tab.handback.subscribeNativeChatDraftReceiptProgress(SCOPE, RECEIPT, (progress) =>
          heard.push(progress.backed)
        )()
      }
      // Bound: the one write's own settlement; subscribers add none, whatever their number.
      expect(reactions).toBe(1)
      storage.update = update
      commit()
      await tab.store.nativeChatComposerDraftWritesSettled()
      expect(heard).toEqual([])
      expect(tab.handback.nativeChatDraftReceiptProgress(SCOPE, RECEIPT).backed).toBe(true)
    }
  )
})

describe('retiring a receipt once its source is dead', () => {
  type Commit = 'confirmed' | 'unconfirmed' | 'refused'

  /** A over B's identified hand-back, with the backend committing as `commit` says. */
  async function adopted(commit: Commit) {
    const tab = await reload()
    tab.drafts.writeNativeChatDraftCache(SCOPE, A)
    await tab.store.nativeChatComposerDraftWritesSettled()
    const update = storage.update
    storage.refuseWrites = commit === 'refused'
    if (commit === 'unconfirmed') {
      storage.update = (...args) => (void update(...args), new Promise<void>(() => {}))
    }
    tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
    if (commit === 'confirmed') {
      await tab.store.nativeChatComposerDraftWritesSettled()
    }
    await Promise.resolve()
    return {
      tab,
      /** The renderer dies; the next one loads what the backend and journal actually hold. */
      crash: async () => {
        tab.store.clearNativeChatComposerDraftsForTests()
        storage.update = update
        storage.refuseWrites = false
        journalRefuses = false
        const cold = await reload()
        await cold.store.nativeChatComposerDraftWritesSettled()
        return { text: text(cold), stored: storage.drafts.get(SCOPE)?.text, cold }
      }
    }
  }

  const identifiedInJournal = () => (localStorage.getItem(JOURNAL_KEY) ?? '').includes('"custody"')
  const progress = (tab: Renderer) => tab.handback.nativeChatDraftReceiptProgress(SCOPE, RECEIPT)

  it('returns B once after a refused backend, retirement on its backup alone and an unload', async () => {
    const tab = await reload()
    tab.drafts.writeNativeChatDraftCache(SCOPE, A)
    await tab.store.nativeChatComposerDraftWritesSettled()
    storage.refuseWrites = true
    tab.handback.adoptIdentifiedNativeChatDraftInput(SCOPE, RECEIPT, { text: B, images: [] }, [])
    // Retired on its backup alone, before the refused commit has even answered.
    expect(progress(tab)).toEqual({ backed: true, incorporated: false, retired: false })
    tab.handback.retireNativeChatDraftReceipt(SCOPE, RECEIPT)
    await tab.store.nativeChatComposerDraftWritesSettled()
    window.dispatchEvent(new Event('pagehide'))
    tab.store.clearNativeChatComposerDraftsForTests()
    storage.refuseWrites = false
    const cold = await reload()
    await cold.store.nativeChatComposerDraftWritesSettled()
    expect(text(cold)).toBe(`${A}\n\n${B}`)
    expect(storage.drafts.get(SCOPE)?.text).toBe(`${A}\n\n${B}`)
  })

  it('replays nothing when the commit holding the receipt landed but its addition was not yet pruned', async () => {
    const { tab, crash } = await adopted('unconfirmed')
    expect(storage.drafts.get(SCOPE)).toMatchObject({ handbacks: [RECEIPT] })
    expect(identifiedInJournal()).toBe(true)
    expect(progress(tab).retired).toBe(false)
    const after = await crash()
    expect(after.text).toBe(`${A}\n\n${B}`)
    expect(after.cold.handback.nativeChatDraftHasReceipt(SCOPE, RECEIPT)).toBe(true)
  })

  it('discharges the addition before the receipt, and keeps the receipt until a commit omits it', async () => {
    const { tab, crash } = await adopted('confirmed')
    expect(progress(tab)).toEqual({ backed: true, incorporated: true, retired: false })
    const update = storage.update
    storage.update = () => new Promise<void>(() => {})
    tab.handback.retireNativeChatDraftReceipt(SCOPE, RECEIPT)
    expect(identifiedInJournal()).toBe(false)
    expect(progress(tab).retired).toBe(false)
    storage.update = update
    const after = await crash()
    expect(after.text).toBe(`${A}\n\n${B}`)
  })

  it.each([
    ['refuses', true, false],
    ['accepts', false, true]
  ])(
    'keeps the last proof when the journal %s the atomic replacement, and replays B once',
    async (_case, refuse, retired) => {
      const { tab, crash } = await adopted('refused')
      await tab.store.nativeChatComposerDraftWritesSettled()
      journalRefuses = refuse
      // The source's own observer hears the completion; nothing else keeps it.
      const heard: boolean[] = []
      const stop = tab.handback.subscribeNativeChatDraftReceiptProgress(SCOPE, RECEIPT, (next) =>
        heard.push(next.retired)
      )
      tab.handback.retireNativeChatDraftReceipt(SCOPE, RECEIPT)
      stop()
      expect(heard.includes(true)).toBe(retired)
      expect(progress(tab).retired).toBe(false)
      expect(identifiedInJournal()).toBe(false)
      // One complete copy of the draft, before or after the replacement; no addition beside it.
      const entries = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? '[]')
      expect(entries.map((entry: { draft?: { text: string } }) => entry.draft?.text)).toEqual([
        `${A}\n\n${B}`
      ])
      const after = await crash()
      expect(after.text).toBe(`${A}\n\n${B}`)
    }
  )

  it.each([3, 30])(
    'ends %i observers each at its own bucket, moved ones included, and twice is inert',
    async (count) => {
      const tab = await reload()
      const stops: (() => void)[] = []
      const heard: string[] = []
      for (let index = 0; index < count; index++) {
        const scope = `agent-session:s${index}`
        tab.handback.adoptIdentifiedNativeChatDraftInput(
          scope,
          RECEIPT,
          { text: B, images: [] },
          []
        )
        stops.push(
          tab.handback.subscribeNativeChatDraftReceiptProgress(scope, RECEIPT, () =>
            heard.push(scope)
          )
        )
      }
      tab.move.moveNativeChatComposerDraft('agent-session:s0', 'agent-session:moved')
      await tab.store.nativeChatComposerDraftWritesSettled()
      const deletes = vi.spyOn(Set.prototype, 'delete')
      stops.forEach((stop) => stop())
      // Bound: one owned-bucket deletion per observer, whatever the number of other buckets.
      expect(deletes).toHaveBeenCalledTimes(count)
      stops.forEach((stop) => stop())
      expect(deletes).toHaveBeenCalledTimes(count)
      deletes.mockRestore()
      heard.length = 0
      tab.handback.adoptIdentifiedNativeChatDraftInput(
        'agent-session:moved',
        RECEIPT_2,
        {
          text: B,
          images: []
        },
        []
      )
      await tab.store.nativeChatComposerDraftWritesSettled()
      expect(heard).toEqual([])
    }
  )
})
