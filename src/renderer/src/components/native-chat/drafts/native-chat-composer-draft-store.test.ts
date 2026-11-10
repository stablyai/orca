// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DraftViews from './native-chat-draft-views'
import type * as AttachmentDraft from '../attachments/chips/native-chat-attachment-draft'
import type * as DraftStore from './native-chat-composer-draft-store'
import type * as DraftLoad from './native-chat-composer-draft-load'
import type * as DraftPersistence from './native-chat-composer-draft-persistence'
import type * as DraftRemoval from './native-chat-composer-draft-removal'
import type * as DraftReset from './native-chat-draft-reset'
import type * as DraftMemory from './native-chat-composer-draft-memory'
import type * as DraftScope from './native-chat-draft-scope'

import {
  createMemoryNativeChatComposerDraftStorage,
  type NativeChatComposerDraftStorage
} from './native-chat-composer-draft-storage'

type DraftModules = {
  drafts: typeof DraftViews
  attachments: typeof AttachmentDraft
  store: typeof DraftStore
  load: typeof DraftLoad
  persistence: typeof DraftPersistence
  removal: typeof DraftRemoval
  reset: typeof DraftReset
  memory: typeof DraftMemory
  scope: typeof DraftScope
}

let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
const loaded: DraftModules[] = []

/** A fresh renderer: module memory is gone, the drafts' storage is not. */
async function reload(
  options: { using?: NativeChatComposerDraftStorage; hydrate?: boolean } = {}
): Promise<DraftModules> {
  vi.resetModules()
  const storageModule = await import('./native-chat-composer-draft-storage')
  storageModule.setNativeChatComposerDraftStorageForTests(options.using ?? storage)
  const modules = {
    drafts: await import('./native-chat-draft-views'),
    attachments: await import('../attachments/chips/native-chat-attachment-draft'),
    store: await import('./native-chat-composer-draft-store'),
    load: await import('./native-chat-composer-draft-load'),
    persistence: await import('./native-chat-composer-draft-persistence'),
    removal: await import('./native-chat-composer-draft-removal'),
    reset: await import('./native-chat-draft-reset'),
    memory: await import('./native-chat-composer-draft-memory'),
    scope: await import('./native-chat-draft-scope')
  }
  loaded.push(modules)
  if (options.hydrate !== false) {
    await modules.load.hydrateNativeChatComposerDrafts()
  }
  return modules
}

function storedDraft(scopeKey: string): Record<string, unknown> | null {
  return storage.drafts.get(scopeKey) ?? null
}

const IMAGES = [
  { id: 'a-1', path: '/repo/shot.png' },
  { id: 'a-2', path: '/remote/repo/diagram.png', connectionId: 'ssh-1' }
]

let modules: DraftModules
const originalPreloadApi = window.api

beforeAll(async () => {
  storage = createMemoryNativeChatComposerDraftStorage()
  await reload()
}, 300_000)

beforeEach(async () => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
  modules = await reload()
})

afterEach(() => {
  Object.assign(window, { api: originalPreloadApi })
  vi.useRealTimers()
  // Each loaded renderer closes its channel, so it hears nothing from the next test.
  for (const instance of loaded.splice(0)) {
    instance.reset.clearNativeChatComposerDraftsForTests()
  }
})

describe('native-chat composer draft store', () => {
  it('replays a change storage had not confirmed when the window went away', async () => {
    const uncommitted = createMemoryNativeChatComposerDraftStorage()
    uncommitted.write = () => new Promise(() => {})
    const lost = await reload({ using: uncommitted })
    lost.drafts.writeNativeChatDraftCache('tab-1:pane', 'typed, then Orca quit')
    window.dispatchEvent(new Event('pagehide'))
    expect(uncommitted.drafts.size).toBe(0)

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('typed, then Orca quit')
    await reloaded.persistence.nativeChatComposerDraftWritesSettled()
    expect(storedDraft('tab-1:pane')?.text).toBe('typed, then Orca quit')
  })

  it('never brings back a draft sent while storage refused, however much was given back to it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    storage.drafts.set('agent-session:s1', { text: 'old saved', images: [], savedAt: 1 })
    const refuse = () => Promise.reject(new DOMException('refused', 'UnknownError'))
    const broken = { ...storage, write: refuse, remove: refuse, update: refuse }
    const refusing = await reload({ using: broken })
    refusing.drafts.appendNativeChatDraftCache('agent-session:s1', 'a'.repeat(150_000))
    refusing.drafts.appendNativeChatDraftCache('agent-session:s1', 'b'.repeat(150_000))
    refusing.drafts.writeNativeChatDraftCache('agent-session:s1', '')
    await refusing.persistence.nativeChatComposerDraftWritesSettled()
    window.dispatchEvent(new Event('pagehide'))
    refusing.reset.clearNativeChatComposerDraftsForTests()

    const next = await reload()
    expect(next.drafts.readNativeChatDraftCache('agent-session:s1')).toBe('')
    warn.mockRestore()
  })

  it('does not replay a live window’s addition journaled after this load began reading', async () => {
    storage.drafts.set('agent-session:s1', { text: 'saved', images: [], savedAt: 1 })
    let commitA: () => void = () => {}
    let aCommitted: () => void = () => {}
    const aDone = new Promise<void>((resolve) => (aCommitted = resolve))
    const aStorage = {
      ...storage,
      write: (scopeKey: string, draft: Parameters<typeof storage.write>[1]) =>
        new Promise<void>((resolve) => {
          commitA = () => {
            storage.drafts.set(scopeKey, draft)
            resolve()
            aCommitted()
          }
        })
    }
    const a = await reload({ using: aStorage })
    let land: () => void = () => {}
    const bStorage = {
      ...storage,
      loadAll: () => {
        const snapshot = new Map(storage.drafts)
        return new Promise<ReadonlyMap<string, unknown>>((resolve) => {
          land = () => resolve(snapshot)
        })
      },
      // IndexedDB orders B's write after A's, which was issued first.
      write: async (scopeKey: string, draft: Parameters<typeof storage.write>[1]) => {
        await aDone
        storage.drafts.set(scopeKey, draft)
      }
    }
    const b = await reload({ using: bStorage, hydrate: false })
    const bLoad = b.load.hydrateNativeChatComposerDrafts()
    a.drafts.writeNativeChatDraftCache('agent-session:s1', 'saved typed in A')
    a.drafts.appendNativeChatDraftCache('agent-session:s1', 'returned')
    land()
    await bLoad
    commitA()
    await a.persistence.nativeChatComposerDraftWritesSettled()
    await b.persistence.nativeChatComposerDraftWritesSettled()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(storedDraft('agent-session:s1')?.text).toBe('saved typed in A\n\nreturned')
    expect(a.drafts.readNativeChatDraftCache('agent-session:s1')).toBe(
      'saved typed in A\n\nreturned'
    )
  })

  it('does not give text back twice when storage committed it but the window died first', async () => {
    storage.drafts.set('agent-session:s1', { text: 'typed earlier', images: [], savedAt: 1 })
    const landsUnconfirmed = {
      ...storage,
      write: (scopeKey: string, draft: Parameters<typeof storage.write>[1]) => {
        storage.drafts.set(scopeKey, draft)
        return new Promise<void>(() => {})
      }
    }
    const crashed = await reload({ using: landsUnconfirmed })
    crashed.drafts.appendNativeChatDraftCache('agent-session:s1', 'returned by Stop')
    crashed.attachments.appendNativeChatAttachmentCache('agent-session:s1', [IMAGES[0]])
    crashed.reset.clearNativeChatComposerDraftsForTests()

    const next = await reload()
    expect(next.drafts.readNativeChatDraftCache('agent-session:s1')).toBe(
      'typed earlier\n\nreturned by Stop'
    )
    expect(next.attachments.readNativeChatAttachmentCache('agent-session:s1')).toEqual([IMAGES[0]])
  })

  it('keeps text given back before the load lands through a crash, without losing the saved draft', async () => {
    storage.drafts.set('agent-session:s1', { text: 'typed earlier', images: [], savedAt: 1 })
    let land: () => void = () => {}
    const crashing = {
      ...storage,
      loadAll: () => {
        const snapshot = new Map(storage.drafts)
        return new Promise<ReadonlyMap<string, unknown>>((resolve) => {
          land = () => resolve(snapshot)
        })
      },
      update: () => new Promise<void>(() => {})
    }
    const crashed = await reload({ using: crashing, hydrate: false })
    await crashed.load.waitForNativeChatComposerDrafts(1)
    crashed.drafts.appendNativeChatDraftCache('agent-session:s1', 'returned by Stop')
    crashed.reset.clearNativeChatComposerDraftsForTests()
    land()

    const next = await reload()
    expect(next.drafts.readNativeChatDraftCache('agent-session:s1')).toBe(
      'typed earlier\n\nreturned by Stop'
    )
  })

  it('brings a pasted image back after a reload as one to attach again, by name', async () => {
    const pasted = { id: 'p-1', path: '/var/folders/T/orca-paste-1-0f.png' }
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', [pasted, IMAGES[0]])
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'caption')
    modules.persistence.flushNativeChatComposerDrafts()

    expect(modules.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      pasted,
      IMAGES[0]
    ])
    const reloaded = await reload()
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      { id: 'p-1', path: '', unavailableName: 'orca-paste-1-0f.png' },
      IMAGES[0]
    ])
  })

  it('saves a paste kept in Orca’s paste folder as the real image, but not one over SSH', async () => {
    const kept = {
      id: 'p-1',
      path: '/Users/me/Library/Application Support/orca/native-chat-pastes/orca-paste-1-0f.png'
    }
    const remote = {
      id: 'p-2',
      path: '/remote/native-chat-pastes/orca-paste-2-0f.png',
      connectionId: 'ssh-1'
    }
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', [kept, remote])

    const reloaded = await reload()
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      kept,
      { id: 'p-2', path: '', unavailableName: 'orca-paste-2-0f.png' }
    ])
  })

  it('removes the saved draft as soon as it is sent, even with a typed change still deferred', async () => {
    vi.useFakeTimers()
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'about to send')
    modules.persistence.flushNativeChatComposerDrafts()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'about to send!')

    // The send clears the text, then the images; the text clear lands before any timer.
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', '')
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: '', images: IMAGES })
    modules.store.updateNativeChatComposerDraft('tab-1:pane', { images: [] }, 'immediate')
    expect(storage.drafts.size).toBe(0)

    vi.advanceTimersByTime(1_000)
    expect(storage.drafts.size).toBe(0)
    vi.useRealTimers()
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('')
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([])
  })

  it('shows a refused draft as not saved, retries it on the next flush, and clears that once it lands', async () => {
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.persistence.flushNativeChatComposerDrafts()
    await modules.persistence.nativeChatComposerDraftWritesSettled()
    const listener = vi.fn()
    modules.store.subscribeToNativeChatComposerDraft('tab-1:pane', listener)

    storage.refuseWrites = true
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'refused')
    modules.persistence.flushNativeChatComposerDrafts()
    await modules.persistence.nativeChatComposerDraftWritesSettled()
    expect(modules.store.isNativeChatComposerDraftUnsaved('tab-1:pane')).toBe(true)
    expect(listener).toHaveBeenCalled()
    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('refused')
    expect(storedDraft('tab-1:pane')?.text).toBe('')

    storage.refuseWrites = false
    // The next flush, here from the window hiding, retries it with no new change.
    window.dispatchEvent(new Event('pagehide'))
    await modules.persistence.nativeChatComposerDraftWritesSettled()
    expect(modules.store.isNativeChatComposerDraftUnsaved('tab-1:pane')).toBe(false)
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('refused')
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual(IMAGES)
  })

  it('shows an unsaved text without storing it, and stores it once the user changes it', async () => {
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'https://example.com/issue/1', {
      unsaved: true
    })
    modules.drafts.writeNativeChatDraftDocument('tab-1:pane', 'https://example.com/issue/1', {
      type: 'doc'
    })
    modules.persistence.flushNativeChatComposerDrafts()

    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(
      'https://example.com/issue/1'
    )
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: '', images: IMAGES })
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'https://example.com/issue/1 please')
    modules.persistence.flushNativeChatComposerDrafts()
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(
      'https://example.com/issue/1 please'
    )
  })

  it('keeps what was typed before a slow load lands, and fills in the rest when it does', async () => {
    storage.drafts.set('tab-1:pane', { text: 'saved earlier', images: [], savedAt: 1 })
    storage.drafts.set('tab-2:pane', { text: 'other chat', images: [], savedAt: 1 })
    let land: () => void = () => {}
    const slow = {
      ...storage,
      loadAll: () =>
        new Promise<ReadonlyMap<string, unknown>>((resolve) => {
          land = () => resolve(new Map(storage.drafts))
        })
    }
    const reloaded = await reload({ using: slow, hydrate: false })
    // Startup gives up waiting; the load is still running.
    await reloaded.load.waitForNativeChatComposerDrafts(1)
    reloaded.drafts.writeNativeChatDraftCache('tab-1:pane', 'typed before the load')

    land()
    await reloaded.load.hydrateNativeChatComposerDrafts()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('typed before the load')
    expect(reloaded.drafts.readNativeChatDraftCache('tab-2:pane')).toBe('other chat')
  })

  it('adds what is given back before a slow load lands to the saved draft, instead of replacing it', async () => {
    storage.drafts.set('agent-session:s1', {
      text: 'saved earlier',
      images: [IMAGES[0]],
      savedAt: 1
    })
    let land: () => void = () => {}
    // Storage reads as of the load's start, as IndexedDB does for a transaction begun first.
    const slow = {
      ...storage,
      loadAll: () => {
        const snapshot = new Map(storage.drafts)
        return new Promise<ReadonlyMap<string, unknown>>((resolve) => {
          land = () => resolve(snapshot)
        })
      }
    }
    const reloaded = await reload({ using: slow, hydrate: false })
    await reloaded.load.waitForNativeChatComposerDrafts(1)
    // Stop's restore, and a paste, before the load lands.
    reloaded.drafts.appendNativeChatDraftCache('agent-session:s1', 'returned by Stop')
    reloaded.attachments.appendNativeChatAttachmentCache('agent-session:s1', [IMAGES[1]], {
      fromUser: true
    })

    land()
    await reloaded.load.hydrateNativeChatComposerDrafts()
    await reloaded.persistence.nativeChatComposerDraftWritesSettled()
    expect(reloaded.drafts.readNativeChatDraftCache('agent-session:s1')).toBe(
      'saved earlier\n\nreturned by Stop'
    )
    expect(reloaded.attachments.readNativeChatAttachmentCache('agent-session:s1')).toEqual(IMAGES)
    expect(storedDraft('agent-session:s1')).toMatchObject({
      text: 'saved earlier\n\nreturned by Stop',
      images: IMAGES
    })
  })

  it('keeps the saved draft when a load that failed once reads after text was given back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    storage.drafts.set('agent-session:s1', { text: 'saved typing', images: [], savedAt: 1 })
    let failures = 1
    const flaky = {
      ...storage,
      loadAll: () =>
        failures-- > 0 ? Promise.reject(new Error('backing store')) : storage.loadAll()
    }
    const reloaded = await reload({ using: flaky, hydrate: false })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await reloaded.load.waitForNativeChatComposerDrafts(1)
    reloaded.drafts.appendNativeChatDraftCache('agent-session:s1', 'given back')
    await reloaded.persistence.nativeChatComposerDraftWritesSettled()
    await vi.advanceTimersByTimeAsync(1_200)
    await reloaded.load.hydrateNativeChatComposerDrafts()
    await reloaded.persistence.nativeChatComposerDraftWritesSettled()

    expect(reloaded.drafts.readNativeChatDraftCache('agent-session:s1')).toBe(
      'saved typing\n\ngiven back'
    )
    expect(storedDraft('agent-session:s1')?.text).toBe('saved typing\n\ngiven back')
    warn.mockRestore()
  })

  it('keeps an append made after a retried load began reading', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let failures = 1
    let land: () => void = () => {}
    const flaky = {
      ...storage,
      loadAll: () => {
        if (failures-- > 0) {
          return Promise.reject(new Error('backing store'))
        }
        const snapshot = new Map(storage.drafts)
        return new Promise<ReadonlyMap<string, unknown>>((resolve) => {
          land = () => resolve(snapshot)
        })
      }
    }
    const reloaded = await reload({ using: flaky, hydrate: false })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await reloaded.load.waitForNativeChatComposerDrafts(1)
    reloaded.drafts.appendNativeChatDraftCache('agent-session:s1', 'first')
    await reloaded.persistence.nativeChatComposerDraftWritesSettled()
    await vi.advanceTimersByTimeAsync(1_200)
    reloaded.drafts.appendNativeChatDraftCache('agent-session:s1', 'second')
    await reloaded.persistence.nativeChatComposerDraftWritesSettled()

    land()
    await reloaded.load.hydrateNativeChatComposerDrafts()
    await reloaded.persistence.nativeChatComposerDraftWritesSettled()
    expect(reloaded.drafts.readNativeChatDraftCache('agent-session:s1')).toBe('first\n\nsecond')
    expect(storedDraft('agent-session:s1')?.text).toBe('first\n\nsecond')
    warn.mockRestore()
  })

  it('starts the load on its first write when startup never did', async () => {
    storage.drafts.set('agent-session:other', { text: 'saved elsewhere', images: [], savedAt: 1 })
    const reloaded = await reload({ hydrate: false })
    reloaded.drafts.writeNativeChatDraftCache('tab-1:pane', 'typed')

    await vi.waitFor(() =>
      expect(reloaded.drafts.readNativeChatDraftCache('agent-session:other')).toBe(
        'saved elsewhere'
      )
    )
  })

  it('does not echo a draft adopted from another window as a change of its own', async () => {
    const other = await reload()
    const doc = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
    })
    other.drafts.writeNativeChatDraftDocument('agent-session:s3', 'abc', doc('abc'))
    other.persistence.flushNativeChatComposerDrafts()
    await vi.waitFor(() =>
      expect(modules.drafts.readNativeChatDraftCache('agent-session:s3')).toBe('abc')
    )
    // The editor here shows the adopted draft and hands back an equal document of its own.
    modules.drafts.writeNativeChatDraftDocument('agent-session:s3', 'abc', doc('abc'))
    other.drafts.writeNativeChatDraftDocument('agent-session:s3', 'abcd', doc('abcd'))
    other.persistence.flushNativeChatComposerDrafts()
    await other.persistence.nativeChatComposerDraftWritesSettled()
    await new Promise((resolve) => setTimeout(resolve, 20))
    modules.persistence.flushNativeChatComposerDrafts()
    await modules.persistence.nativeChatComposerDraftWritesSettled()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(other.drafts.readNativeChatDraftCache('agent-session:s3')).toBe('abcd')
    expect(storedDraft('agent-session:s3')?.text).toBe('abcd')
  })

  it('never replays a closed window’s journal over a draft another window sent since', async () => {
    const tabB = modules
    // Tab A's write lands, but the page goes away before it is confirmed.
    const landsUnconfirmed = {
      ...storage,
      write: (scopeKey: string, draft: Parameters<typeof storage.write>[1]) => {
        storage.drafts.set(scopeKey, draft)
        return new Promise<void>(() => {})
      }
    }
    const tabA = await reload({ using: landsUnconfirmed })
    tabA.drafts.writeNativeChatDraftCache('agent-session:s1', 'typed in A, then A closed')
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem('orca:nativeChatComposerDraftJournal:v1')).toContain('typed in A')
    tabA.reset.clearNativeChatComposerDraftsForTests()

    tabB.drafts.writeNativeChatDraftCache('agent-session:s1', 'written in B')
    tabB.store.clearNativeChatComposerDraftIfUnchanged('agent-session:s1', {
      text: 'written in B',
      images: []
    })
    await tabB.persistence.nativeChatComposerDraftWritesSettled()

    const tabC = await reload()
    expect(tabC.drafts.readNativeChatDraftCache('agent-session:s1')).toBe('')
    expect(localStorage.getItem('orca:nativeChatComposerDraftJournal:v1')).toBeNull()
  })

  it('keeps a refused draft in the journal for the next run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    storage.refuseWrites = true
    modules.drafts.writeNativeChatDraftCache('agent-session:s1', 'typed while storage refuses')
    modules.persistence.flushNativeChatComposerDrafts()
    await modules.persistence.nativeChatComposerDraftWritesSettled()
    window.dispatchEvent(new Event('pagehide'))
    await modules.persistence.nativeChatComposerDraftWritesSettled()
    modules.reset.clearNativeChatComposerDraftsForTests()

    storage.refuseWrites = false
    const next = await reload()
    expect(next.drafts.readNativeChatDraftCache('agent-session:s1')).toBe(
      'typed while storage refuses'
    )
    warn.mockRestore()
  })

  it('keeps the journal under its cap while storage refuses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    storage.refuseWrites = true
    const durable: boolean[] = []
    for (let index = 0; index < 10; index += 1) {
      durable.push(
        modules.store.appendToNativeChatComposerDraft(`agent-session:big-${index}`, {
          text: 'x'.repeat(200_000)
        })
      )
      modules.drafts.writeNativeChatDraftCache(`tab-${index}:pane`, 'y'.repeat(60_000))
    }
    modules.persistence.flushNativeChatComposerDrafts()
    await modules.persistence.nativeChatComposerDraftWritesSettled()
    window.dispatchEvent(new Event('pagehide'))

    const journal = localStorage.getItem('orca:nativeChatComposerDraftJournal:v1') ?? ''
    expect(journal.length).toBeLessThanOrEqual(800_000 + 256_000)
    // What no longer fits is reported, so its source is kept until storage confirms it.
    expect(durable).toContain(false)
    warn.mockRestore()
  })

  it('follows another window’s save of a draft, unless a change here is not saved yet', async () => {
    const other = await reload()
    other.drafts.appendNativeChatDraftCache('tab-1:pane', 'from the other tab')
    await vi.waitFor(() =>
      expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('from the other tab')
    )

    other.drafts.writeNativeChatDraftCache('tab-1:pane', '')
    await vi.waitFor(() => expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(''))

    vi.useFakeTimers()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'mine, not saved yet')
    other.drafts.appendNativeChatDraftCache('tab-1:pane', 'theirs')
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('mine, not saved yet')
  })

  it('records the workspace a draft was written in, and deletes a closed chat’s draft with it', async () => {
    const owner = { workspaceId: 'repo::/wt', executionHostId: 'local' as const }
    modules.memory.setNativeChatComposerDraftOwnerResolver((scopeKey) =>
      scopeKey === 'agent-session:closed' ? owner : undefined
    )
    modules.drafts.writeNativeChatDraftCache('agent-session:closed', 'unsent')
    modules.drafts.writeNativeChatDraftCache('agent-session:other', 'kept')
    modules.persistence.flushNativeChatComposerDrafts()
    expect(storedDraft('agent-session:closed')?.owner).toEqual(owner)

    const reloaded = await reload()
    reloaded.removal.deleteNativeChatComposerDraftsOwnedBy({ ...owner, executionHostId: 'ssh:box' })
    expect(reloaded.drafts.readNativeChatDraftCache('agent-session:closed')).toBe('unsent')
    reloaded.removal.deleteNativeChatComposerDraftsOwnedBy(owner)
    expect(reloaded.drafts.readNativeChatDraftCache('agent-session:closed')).toBe('')
    expect(storedDraft('agent-session:closed')).toBeNull()
    expect(storedDraft('agent-session:other')?.text).toBe('kept')
  })

  it('keeps a conversation’s draft when a tab is closed, and drops it when deleted by its key', async () => {
    const conversation = modules.scope.structuredAgentSessionDraftScopeKey('session-1')
    expect(conversation).toBe('agent-session:session-1')
    modules.drafts.writeNativeChatDraftCache(conversation, 'unsent')
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'pane draft')
    modules.persistence.flushNativeChatComposerDrafts()
    // The prefix before the conversation key's ':' must never read as a tab id.
    modules.removal.deleteNativeChatComposerDraftsForTab('agent-session')
    modules.removal.deleteNativeChatComposerDraftsForTab('tab-1')
    expect(modules.drafts.readNativeChatDraftCache(conversation)).toBe('unsent')

    const listener = vi.fn()
    modules.store.subscribeToNativeChatComposerDraft(conversation, listener)
    modules.drafts.writeNativeChatDraftCache(conversation, 'unsent, still deferred')
    modules.removal.deleteNativeChatComposerDraft(conversation)
    expect(listener).toHaveBeenCalled()
    expect(modules.drafts.readNativeChatDraftCache(conversation)).toBe('')
    modules.persistence.flushNativeChatComposerDrafts()
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache(conversation)).toBe('')
  })

  it('keeps the drafts of a tab whose id extends the closed one', async () => {
    // A second chat for one session gets `<tab id>:history-1`, so a prefix match would reach it.
    const closed = 'structured-agent-session-claude_1'
    const kept = `${closed}:history-1`
    modules.drafts.writeNativeChatDraftCache(`${closed}:0a1b2c3d-0000-4000-a000-000000000001`, 'a')
    modules.drafts.writeNativeChatDraftCache(`${kept}:0a1b2c3d-0000-4000-a000-000000000002`, 'b')
    modules.persistence.flushNativeChatComposerDrafts()

    modules.removal.deleteNativeChatComposerDraftsForTab(closed)
    const reloaded = await reload()
    expect(
      reloaded.drafts.readNativeChatDraftCache(`${closed}:0a1b2c3d-0000-4000-a000-000000000001`)
    ).toBe('')
    expect(
      reloaded.drafts.readNativeChatDraftCache(`${kept}:0a1b2c3d-0000-4000-a000-000000000002`)
    ).toBe('b')
  })
})
