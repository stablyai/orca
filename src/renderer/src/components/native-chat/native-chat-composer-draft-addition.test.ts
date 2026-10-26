// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DraftStore from './native-chat-composer-draft-store'
import type * as DraftCache from './native-chat-draft-cache'
import {
  placeNativeChatComposerDraftAddition,
  withNativeChatComposerDraftAddition
} from './native-chat-composer-draft-addition'
import {
  createMemoryNativeChatComposerDraftStorage,
  type NativeChatComposerDraftStorage
} from './native-chat-composer-draft-storage'

type DraftModules = { drafts: typeof DraftCache; store: typeof DraftStore }

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
    drafts: await import('./native-chat-draft-cache'),
    store: await import('./native-chat-composer-draft-store')
  }
  loaded.push(modules)
  if (options.hydrate !== false) {
    await modules.store.hydrateNativeChatComposerDrafts()
  }
  return modules
}

/** Storage whose load waits for `land()`, with what it held when the load began reading. */
function slowLoading(): { using: NativeChatComposerDraftStorage; land: () => void } {
  let land: () => void = () => {}
  const using = {
    ...storage,
    loadAll: () => {
      const snapshot = new Map(storage.drafts)
      return new Promise<ReadonlyMap<string, unknown>>((resolve) => {
        land = () => resolve(snapshot)
      })
    }
  }
  return { using, land: () => land() }
}

const SCOPE = 'agent-session:s1'

beforeEach(() => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
})

afterEach(() => {
  for (const instance of loaded.splice(0)) {
    instance.store.clearNativeChatComposerDraftsForTests()
  }
})

describe('native-chat composer draft addition', () => {
  it('adds text to a whitespace-only draft without leading blank lines', () => {
    const add = (text: string): string =>
      withNativeChatComposerDraftAddition({ text, images: [] }, { text: 'go' }).text
    expect(add('  \n\n')).toBe('go')
    expect(add('please\n')).toBe('please\n\ngo')
  })

  it('adds text only where the draft does not already end with it as its own paragraph', () => {
    const add = (text: string): string =>
      withNativeChatComposerDraftAddition({ text, images: [] }, { text: 'go' }).text
    expect(add('please go')).toBe('please go\n\ngo')
    expect(add('please\n\ngo')).toBe('please\n\ngo')
    expect(add('go\n')).toBe('go\n')
  })

  it('fills an unavailable image once, however often the addition is made', () => {
    const draft = { text: '', images: [{ id: 'p', path: '', unavailableName: 'a.png' }] }
    const placed = placeNativeChatComposerDraftAddition(draft, {
      images: [{ id: 'y', path: '/repo/a.png' }],
      fromUser: true
    })
    const filled = { ...draft, ...withNativeChatComposerDraftAddition(draft, placed) }
    expect(withNativeChatComposerDraftAddition(filled, placed).images).toEqual([
      { id: 'p', path: '/repo/a.png' }
    ])
  })

  it('gives "go" back onto "please go" after a crash before storage commits it', async () => {
    storage.drafts.set(SCOPE, { text: 'please go', images: [], savedAt: 1 })
    const crashing = { ...storage, write: () => new Promise<void>(() => {}) }
    const crashed = await reload({ using: crashing })
    expect(crashed.drafts.appendNativeChatDraftCache(SCOPE, 'go')).toBe(true)
    crashed.store.clearNativeChatComposerDraftsForTests()

    const next = await reload()
    expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('please go\n\ngo')
  })

  it('keeps an image that finished while one attached before it was still on its way', async () => {
    const drafts = (await reload()).drafts
    const pending = await import('./native-chat-pending-attachment-cache')
    pending.addNativeChatPendingAttachment(SCOPE, { id: 'first', path: '', pending: true })
    pending.addNativeChatPendingAttachment(SCOPE, { id: 'second', path: '', pending: true })
    pending.settleNativeChatPendingAttachment(SCOPE, 'second', '/repo/b.png')
    expect(drafts.readNativeChatAttachmentCache(SCOPE)).toHaveLength(1)

    const next = await reload()
    expect(next.drafts.readNativeChatAttachmentCache(SCOPE)).toEqual([
      { id: 'second', path: '/repo/b.png' }
    ])
  })

  it('keeps an image in front of one attached after it when a crash replays it', async () => {
    storage.drafts.set(SCOPE, { text: '', images: [{ id: 'b', path: '/repo/b.png' }], savedAt: 1 })
    const crashing = { ...storage, write: () => new Promise<void>(() => {}) }
    const crashed = await reload({ using: crashing })
    crashed.store.appendToNativeChatComposerDraft(SCOPE, {
      images: [{ id: 'a', path: '/repo/a.png' }],
      fromUser: true,
      before: 'b'
    })
    crashed.store.clearNativeChatComposerDraftsForTests()

    const next = await reload()
    expect(next.store.readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)).toEqual([
      'a',
      'b'
    ])
  })

  it('keeps a second attachment of the same file when a crash replays it', async () => {
    storage.drafts.set(SCOPE, { text: '', images: [{ id: 'x', path: '/repo/a.png' }], savedAt: 1 })
    const crashing = { ...storage, write: () => new Promise<void>(() => {}) }
    const crashed = await reload({ using: crashing })
    crashed.store.appendToNativeChatComposerDraft(SCOPE, {
      images: [{ id: 'y', path: '/repo/a.png' }],
      fromUser: true
    })
    crashed.store.clearNativeChatComposerDraftsForTests()

    const next = await reload()
    expect(next.store.readNativeChatComposerDraft(SCOPE).images.map(({ id }) => id)).toEqual([
      'x',
      'y'
    ])
  })

  it('fills an unavailable image once with the file attached again, when a crash replays it', async () => {
    storage.drafts.set(SCOPE, {
      text: '',
      images: [{ id: 'p', path: '', unavailableName: 'a.png' }],
      savedAt: 1
    })
    const crashing = { ...storage, write: () => new Promise<void>(() => {}) }
    const crashed = await reload({ using: crashing })
    crashed.store.appendToNativeChatComposerDraft(SCOPE, {
      images: [{ id: 'y', path: '/repo/a.png' }],
      fromUser: true
    })
    crashed.store.clearNativeChatComposerDraftsForTests()

    const next = await reload()
    expect(next.store.readNativeChatComposerDraft(SCOPE).images).toEqual([
      { id: 'p', path: '/repo/a.png' }
    ])
  })

  it('keeps a hand-back the draft already ends with when that draft was never saved', async () => {
    const crashing = { ...storage, write: () => new Promise<void>(() => {}) }
    const crashed = await reload({ using: crashing })
    crashed.drafts.writeNativeChatDraftCache(SCOPE, 'hello')
    expect(crashed.drafts.appendNativeChatDraftCache(SCOPE, 'hello')).toBe(true)
    crashed.store.clearNativeChatComposerDraftsForTests()

    const next = await reload()
    expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('hello')
  })

  it('makes text given back before the load lands again only where the loaded draft lacks it', async () => {
    // An earlier run gave "go" back, then crashed before its copy was deleted.
    storage.drafts.set(SCOPE, { text: 'typed earlier\n\ngo', images: [], savedAt: 1 })
    storage.drafts.set('agent-session:s2', { text: 'please go', images: [], savedAt: 1 })
    const { using, land } = slowLoading()
    const next = await reload({ using, hydrate: false })
    await next.store.waitForNativeChatComposerDrafts(1)
    next.drafts.appendNativeChatDraftCache(SCOPE, 'go')
    next.drafts.appendNativeChatDraftCache('agent-session:s2', 'go')
    land()
    await next.store.waitForNativeChatComposerDrafts(1_000)
    await next.store.nativeChatComposerDraftWritesSettled()

    expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('typed earlier\n\ngo')
    expect(storage.drafts.get(SCOPE)?.text).toBe('typed earlier\n\ngo')
    expect(next.drafts.readNativeChatDraftCache('agent-session:s2')).toBe('please go\n\ngo')
    expect(storage.drafts.get('agent-session:s2')?.text).toBe('please go\n\ngo')
  })

  it.each(['delayed load', 'crash replay'])(
    'keeps picked nodes when appending through %s',
    async (mode) => {
      const document = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'nativeChatSkill', attrs: { token: '$review' } },
              { type: 'text', text: '-long' }
            ]
          }
        ]
      }
      storage.drafts.set(SCOPE, { text: '$review-long', document, images: [], savedAt: 1 })
      let next: DraftModules
      if (mode === 'crash replay') {
        const crashed = await reload({
          using: { ...storage, write: () => new Promise<void>(() => {}) }
        })
        crashed.drafts.appendNativeChatDraftCache(SCOPE, '@/stored/file.pdf')
        crashed.store.clearNativeChatComposerDraftsForTests()
        next = await reload()
      } else {
        const { using, land } = slowLoading()
        next = await reload({ using, hydrate: false })
        await next.store.waitForNativeChatComposerDrafts(1)
        next.drafts.appendNativeChatDraftCache(SCOPE, '@/stored/file.pdf')
        land()
        await next.store.waitForNativeChatComposerDrafts(1_000)
      }
      await next.store.nativeChatComposerDraftWritesSettled()
      expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('$review-long\n\n@/stored/file.pdf')
      expect(next.store.readNativeChatComposerDraft(SCOPE).document?.content?.[0]).toEqual(
        document.content[0]
      )
      expect(storage.drafts.get(SCOPE)?.document?.content?.[0]).toEqual(document.content[0])
    }
  )
})
