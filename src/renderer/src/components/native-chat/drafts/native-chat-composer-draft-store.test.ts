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

const originalPreloadApi = window.api

beforeAll(async () => {
  storage = createMemoryNativeChatComposerDraftStorage()
  await reload()
}, 300_000)

beforeEach(async () => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
  await reload()
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
})
