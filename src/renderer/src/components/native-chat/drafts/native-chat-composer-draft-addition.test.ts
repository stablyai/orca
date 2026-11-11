// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    instance.reset.clearNativeChatComposerDraftsForTests()
  }
})

describe('native-chat composer draft addition', () => {
  it('gives "go" back onto "please go" after a crash before storage commits it', async () => {
    storage.drafts.set(SCOPE, { text: 'please go', images: [], savedAt: 1 })
    const crashing = { ...storage, write: () => new Promise<void>(() => {}) }
    const crashed = await reload({ using: crashing })
    expect(crashed.drafts.appendNativeChatDraftCache(SCOPE, 'go')).toBe(true)
    crashed.reset.clearNativeChatComposerDraftsForTests()

    const next = await reload()
    expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('please go\n\ngo')
  })

  it('keeps an image that finished while one attached before it was still on its way', async () => {
    const drafts = (await reload()).attachments
    const pending = await import('../attachments/chips/native-chat-pending-attachment-cache')
    pending.addNativeChatPendingAttachment(SCOPE, { id: 'first', path: '', pending: true })
    pending.addNativeChatPendingAttachment(SCOPE, { id: 'second', path: '', pending: true })
    pending.settleNativeChatPendingAttachment(SCOPE, 'second', '/repo/b.png')
    expect(drafts.readNativeChatAttachmentCache(SCOPE)).toHaveLength(1)

    const next = await reload()
    expect(next.attachments.readNativeChatAttachmentCache(SCOPE)).toEqual([
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
    crashed.reset.clearNativeChatComposerDraftsForTests()

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
    crashed.reset.clearNativeChatComposerDraftsForTests()

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
    crashed.reset.clearNativeChatComposerDraftsForTests()

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
    crashed.reset.clearNativeChatComposerDraftsForTests()

    const next = await reload()
    expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('hello')
  })

  it('makes text given back before the load lands again only where the loaded draft lacks it', async () => {
    // An earlier run gave "go" back, then crashed before its copy was deleted.
    storage.drafts.set(SCOPE, { text: 'typed earlier\n\ngo', images: [], savedAt: 1 })
    storage.drafts.set('agent-session:s2', { text: 'please go', images: [], savedAt: 1 })
    const { using, land } = slowLoading()
    const next = await reload({ using, hydrate: false })
    await next.load.waitForNativeChatComposerDrafts(1)
    next.drafts.appendNativeChatDraftCache(SCOPE, 'go')
    next.drafts.appendNativeChatDraftCache('agent-session:s2', 'go')
    land()
    await next.load.waitForNativeChatComposerDrafts(1_000)
    await next.persistence.nativeChatComposerDraftWritesSettled()

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
        crashed.reset.clearNativeChatComposerDraftsForTests()
        next = await reload()
      } else {
        const { using, land } = slowLoading()
        next = await reload({ using, hydrate: false })
        await next.load.waitForNativeChatComposerDrafts(1)
        next.drafts.appendNativeChatDraftCache(SCOPE, '@/stored/file.pdf')
        land()
        await next.load.waitForNativeChatComposerDrafts(1_000)
      }
      await next.persistence.nativeChatComposerDraftWritesSettled()
      expect(next.drafts.readNativeChatDraftCache(SCOPE)).toBe('$review-long\n\n@/stored/file.pdf')
      expect(next.store.readNativeChatComposerDraft(SCOPE).document?.content?.[0]).toEqual(
        document.content[0]
      )
      expect(storage.drafts.get(SCOPE)?.document?.content?.[0]).toEqual(document.content[0])
    }
  )
})
