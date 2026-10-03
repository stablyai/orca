// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from './native-chat-composer-scope-cache'
import type * as DraftStore from './native-chat-composer-draft-store'
import type * as DraftCache from './native-chat-draft-cache'
import type * as ComposerAttachments from './use-native-chat-composer-attachments'
import { MAX_PROMPT_BYTES } from '../../../../shared/rpc-contract/structured-agent-session-params'
import { writeOutbox } from './structured-agent-session-outbox-storage'

const DRAFT_KEY_PREFIX = 'orca:nativeChatComposerDraft:v1:'
// Chromium's per-origin localStorage quota: 10 MiB of UTF-16, keys included.
const CHROMIUM_QUOTA_CHARS = 5 * 1024 * 1024

type DraftModules = {
  drafts: typeof DraftCache
  attachments: typeof ComposerAttachments
  store: typeof DraftStore
}

/** A fresh renderer: module memory is gone, localStorage is not. */
async function reload(): Promise<DraftModules> {
  vi.resetModules()
  return {
    drafts: await import('./native-chat-draft-cache'),
    attachments: await import('./use-native-chat-composer-attachments'),
    store: await import('./native-chat-composer-draft-store')
  }
}

/** Storage that refuses writes past a quota, the way Chromium's does, or every write when told. */
class QuotaStorage {
  private readonly items = new Map<string, string>()
  refuseWrites = false
  writes = 0
  constructor(private readonly quotaChars: number) {}
  get length(): number {
    return this.items.size
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.writes += 1
    if (this.refuseWrites) {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    const used = [...this.items].reduce(
      (total, [itemKey, itemValue]) =>
        itemKey === key ? total : total + itemKey.length + itemValue.length,
      0
    )
    if (used + key.length + value.length > this.quotaChars) {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    this.items.set(key, value)
  }
  removeItem(key: string): void {
    this.items.delete(key)
  }
  clear(): void {
    this.items.clear()
  }
}

let storage: QuotaStorage

function storedDraftKeys(): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? '').filter(
    (key) => key.startsWith(DRAFT_KEY_PREFIX)
  )
}

function storedDraft(scopeKey: string): Record<string, unknown> | null {
  const raw = storage.getItem(`${DRAFT_KEY_PREFIX}${encodeURIComponent(scopeKey)}`)
  return raw === null ? null : JSON.parse(raw)
}

const IMAGES = [
  { id: 'a-1', path: '/repo/shot.png' },
  { id: 'a-2', path: '/remote/repo/diagram.png', connectionId: 'ssh-1' }
]

const SKILL_DOCUMENT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'with /skill' }] }]
}

let modules: DraftModules

// The attachment module's import graph is slow to transform cold; later reloads reuse it.
beforeAll(async () => {
  await reload()
}, 300_000)

beforeEach(async () => {
  storage = new QuotaStorage(CHROMIUM_QUOTA_CHARS)
  vi.stubGlobal('localStorage', storage)
  modules = await reload()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('native-chat composer draft store', () => {
  it('gives back the text, its editor document and the images after a reload', async () => {
    vi.useFakeTimers()
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.drafts.writeNativeChatDraftDocument('tab-1:pane', 'with /skill', SKILL_DOCUMENT)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'with /skill')
    expect(storedDraft('tab-1:pane')?.text).toBe('')
    vi.advanceTimersByTime(250)

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('with /skill')
    expect(reloaded.drafts.readNativeChatDraftDocument('tab-1:pane', 'with /skill')).toEqual(
      SKILL_DOCUMENT
    )
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual(IMAGES)
  })

  it('writes a still-deferred draft when the window goes away', async () => {
    vi.useFakeTimers()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'typed just before reload')
    window.dispatchEvent(new Event('pagehide'))

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('typed just before reload')
  })

  it('saves text and images given back to the composer at once, before their other copy goes', async () => {
    vi.useFakeTimers()
    // No timer advanced: a crash right after either restore still keeps it.
    modules.drafts.appendNativeChatDraftCache('tab-1:pane', 'withdrawn by Stop')
    expect(storedDraft('tab-1:pane')?.text).toBe('withdrawn by Stop')
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('withdrawn by Stop')
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual(IMAGES)
  })

  it('keeps a pasted image for this run only, and still saves the files the user attached', async () => {
    const pasted = { id: 'p-1', path: '/var/folders/T/orca-paste-1-0f.png' }
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', [pasted, IMAGES[0]])
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'caption')
    modules.store.flushNativeChatComposerDrafts()

    expect(modules.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([
      pasted,
      IMAGES[0]
    ])
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: 'caption', images: [IMAGES[0]] })
    const reloaded = await reload()
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([IMAGES[0]])
  })

  it('stores nothing for a draft that holds only a pasted image', () => {
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', [
      { id: 'p-1', path: '/tmp/orca-paste-1-0f.png', connectionId: 'ssh-1' }
    ])

    expect(storedDraftKeys()).toEqual([])
  })

  it('appends a given-back message after a draft restored from a reload', async () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'mine')
    modules.store.flushNativeChatComposerDrafts()

    const reloaded = await reload()
    reloaded.drafts.appendNativeChatDraftCache('tab-1:pane', 'returned')
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('mine\n\nreturned')
  })

  it('removes the saved draft as soon as it is sent, even with a typed change still deferred', async () => {
    vi.useFakeTimers()
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'about to send')
    modules.store.flushNativeChatComposerDrafts()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'about to send!')

    // The send clears the text, then the images; the text clear lands before any timer.
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', '')
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: '', images: IMAGES })
    modules.store.updateNativeChatComposerDraft('tab-1:pane', { images: [] }, 'immediate')
    expect(storedDraftKeys()).toEqual([])

    vi.advanceTimersByTime(1_000)
    expect(storedDraftKeys()).toEqual([])
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('')
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual([])
  })

  it('removes an emptied draft without waiting for a flush', () => {
    vi.useFakeTimers()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'about to send')
    modules.store.flushNativeChatComposerDrafts()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', '')

    expect(storedDraftKeys()).toEqual([])
  })

  it('keeps the images after a long paste is trimmed back, and after a failed write', async () => {
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'x'.repeat(1_000_000))
    modules.store.flushNativeChatComposerDrafts()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'short again')
    modules.store.flushNativeChatComposerDrafts()

    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('short again')
    expect(reloaded.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual(IMAGES)

    storage.refuseWrites = true
    reloaded.drafts.writeNativeChatDraftCache('tab-1:pane', 'refused')
    reloaded.store.flushNativeChatComposerDrafts()
    expect(storedDraft('tab-1:pane')?.text).toBe('short again')
    storage.refuseWrites = false
    reloaded.drafts.writeNativeChatDraftCache('tab-1:pane', 'lands')
    reloaded.store.flushNativeChatComposerDrafts()

    const reloadedAgain = await reload()
    expect(reloadedAgain.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('lands')
    expect(reloadedAgain.attachments.readNativeChatAttachmentCache('tab-1:pane')).toEqual(IMAGES)
  })

  it('keeps a given-back message of the largest size a send allows, with what was typed before', async () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'my earlier typing')
    modules.store.flushNativeChatComposerDrafts()
    const returned = 'a line with "quotes"\n'.repeat(Math.floor((MAX_PROMPT_BYTES - 100) / 24))
    expect(JSON.stringify([{ type: 'text', text: returned }]).length).toBeLessThanOrEqual(
      MAX_PROMPT_BYTES
    )

    modules.drafts.appendNativeChatDraftCache('tab-1:pane', returned)
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(
      `my earlier typing\n\n${returned}`
    )
  })

  it('keeps a plain given-back message of about 260k characters', async () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'my earlier typing')
    modules.store.flushNativeChatComposerDrafts()
    const returned = 'y'.repeat(260_000)
    expect(JSON.stringify([{ type: 'text', text: returned }]).length).toBeLessThanOrEqual(
      MAX_PROMPT_BYTES
    )

    modules.drafts.appendNativeChatDraftCache('tab-1:pane', returned)
    expect(storedDraft('tab-1:pane')?.text).toBe(`my earlier typing\n\n${returned}`)
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(
      `my earlier typing\n\n${returned}`
    )
  })

  it('shows an unsaved text without storing it, and stores it once the user changes it', async () => {
    modules.attachments.appendNativeChatAttachmentCache('tab-1:pane', IMAGES)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'https://example.com/issue/1', {
      unsaved: true
    })
    modules.drafts.writeNativeChatDraftDocument('tab-1:pane', 'https://example.com/issue/1', {
      type: 'doc'
    })
    modules.store.flushNativeChatComposerDrafts()

    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(
      'https://example.com/issue/1'
    )
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: '', images: IMAGES })
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'https://example.com/issue/1 please')
    modules.store.flushNativeChatComposerDrafts()
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(
      'https://example.com/issue/1 please'
    )
  })

  it('keeps the images of a draft pushed out of storage when its text is edited again', async () => {
    modules.drafts.writeNativeChatDraftCache('old:pane', 'caption')
    modules.attachments.appendNativeChatAttachmentCache('old:pane', IMAGES)
    for (let index = 0; index < 6; index += 1) {
      modules.drafts.writeNativeChatDraftCache(`tab-${index}:pane`, 'd'.repeat(190_000))
      modules.store.flushNativeChatComposerDrafts()
    }
    expect(storedDraft('old:pane')).toBeNull()

    modules.drafts.writeNativeChatDraftCache('old:pane', 'caption edited')
    modules.store.flushNativeChatComposerDrafts()
    expect(storedDraft('old:pane')).toMatchObject({ text: 'caption edited', images: IMAGES })
  })

  it('keeps a refused draft in memory and writes it on the next flush', async () => {
    storage.refuseWrites = true
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'still here')
    expect(() => modules.store.flushNativeChatComposerDrafts()).not.toThrow()
    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('still here')
    expect(storedDraftKeys()).toEqual([])

    storage.refuseWrites = false
    window.dispatchEvent(new Event('pagehide'))
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('still here')
  })

  it('keeps the text but not the document when the document alone makes the draft too large', async () => {
    const document = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'y'.repeat(150_000) }] }],
      attrs: { padding: 'z'.repeat(1_000_000) }
    }
    modules.drafts.writeNativeChatDraftDocument('tab-1:pane', 'with a big document', document)
    modules.store.flushNativeChatComposerDrafts()

    expect(modules.drafts.readNativeChatDraftDocument('tab-1:pane', 'with a big document')).toBe(
      document
    )
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('with a big document')
    expect(
      reloaded.drafts.readNativeChatDraftDocument('tab-1:pane', 'with a big document')
    ).toBeUndefined()
  })

  it('keeps a draft too large to store in memory only, and never brings back its older copy', async () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'older')
    modules.store.flushNativeChatComposerDrafts()
    const huge = 'x'.repeat(1_000_000)
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', huge)
    modules.store.flushNativeChatComposerDrafts()

    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane')).toBe(huge)
    expect(storedDraftKeys()).toEqual([])
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane')).toBe('')
  })

  it('writes nothing when a change leaves the draft as it was', () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'same')
    modules.store.flushNativeChatComposerDrafts()
    const writes = storage.writes

    modules.drafts.writeNativeChatDraftCache('tab-1:pane', 'same')
    modules.store.updateNativeChatComposerDraft('tab-1:pane', { images: [] }, 'immediate')
    modules.store.flushNativeChatComposerDrafts()
    expect(storage.writes).toBe(writes)
  })

  it('keeps only the newest drafts and drops unreadable ones', () => {
    storage.setItem(`${DRAFT_KEY_PREFIX}broken`, '{not json')
    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 5
    for (let index = 0; index < total; index += 1) {
      modules.drafts.writeNativeChatDraftCache(`scope-${index}`, `draft-${index}`)
      modules.store.flushNativeChatComposerDrafts()
    }

    const keys = storedDraftKeys()
    expect(keys).toHaveLength(NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX)
    expect(keys).not.toContain(`${DRAFT_KEY_PREFIX}broken`)
    expect(keys).not.toContain(`${DRAFT_KEY_PREFIX}scope-0`)
    expect(keys).toContain(`${DRAFT_KEY_PREFIX}scope-${total - 1}`)
  })

  it('saves a draft pushed out of memory before its deferred write landed', () => {
    vi.useFakeTimers()
    modules.drafts.writeNativeChatDraftCache('scope-first', 'oldest unsaved')
    for (let index = 0; index < NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX; index += 1) {
      modules.drafts.writeNativeChatDraftCache(`scope-${index}`, `draft-${index}`)
    }

    expect(storedDraft('scope-first')?.text).toBe('oldest unsaved')
    expect(modules.drafts.readNativeChatDraftCache('scope-first')).toBe('oldest unsaved')
  })

  it('keeps every draft together within a budget, so a large send still fits in the outbox', async () => {
    for (let index = 0; index < 40; index += 1) {
      modules.drafts.writeNativeChatDraftCache(`tab-${index}:pane`, 'd'.repeat(190_000))
      modules.store.flushNativeChatComposerDrafts()
    }
    expect(modules.drafts.readNativeChatDraftCache('tab-0:pane')).toHaveLength(190_000)
    const storedChars = storedDraftKeys().reduce(
      (total, key) => total + key.length + (storage.getItem(key)?.length ?? 0),
      0
    )
    expect(storedChars).toBeLessThanOrEqual(1_000_000)
    expect(storedDraftKeys()).toContain(`${DRAFT_KEY_PREFIX}${encodeURIComponent('tab-39:pane')}`)

    const send = createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'message-1',
      sessionId: 'session-1',
      text: 'p'.repeat(3_000_000),
      attachments: [],
      queuedAt: 1
    })
    expect(writeOutbox('session-1', [send])).toBe(true)
  })

  it('drops the drafts of a closed tab and leaves other tabs alone', async () => {
    modules.drafts.writeNativeChatDraftCache('tab-1:pane-a', 'a')
    modules.drafts.writeNativeChatDraftCache('tab-1:pane-b', 'b')
    modules.drafts.writeNativeChatDraftCache('tab-10:pane', 'other tab')
    modules.store.flushNativeChatComposerDrafts()
    modules.drafts.writeNativeChatDraftCache('tab-1:pane-a', 'a, still deferred')

    modules.store.deleteNativeChatComposerDraftsForTab('tab-1')
    expect(modules.drafts.readNativeChatDraftCache('tab-1:pane-a')).toBe('')
    modules.store.flushNativeChatComposerDrafts()
    const reloaded = await reload()
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane-a')).toBe('')
    expect(reloaded.drafts.readNativeChatDraftCache('tab-1:pane-b')).toBe('')
    expect(reloaded.drafts.readNativeChatDraftCache('tab-10:pane')).toBe('other tab')
  })

  it('keeps the drafts of a tab whose id extends the closed one', async () => {
    // A second chat for one session gets `<tab id>:history-1`, so a prefix match would reach it.
    const closed = 'structured-agent-session-claude_1'
    const kept = `${closed}:history-1`
    modules.drafts.writeNativeChatDraftCache(`${closed}:0a1b2c3d-0000-4000-a000-000000000001`, 'a')
    modules.drafts.writeNativeChatDraftCache(`${kept}:0a1b2c3d-0000-4000-a000-000000000002`, 'b')
    modules.store.flushNativeChatComposerDrafts()

    modules.store.deleteNativeChatComposerDraftsForTab(closed)
    const reloaded = await reload()
    expect(
      reloaded.drafts.readNativeChatDraftCache(`${closed}:0a1b2c3d-0000-4000-a000-000000000001`)
    ).toBe('')
    expect(
      reloaded.drafts.readNativeChatDraftCache(`${kept}:0a1b2c3d-0000-4000-a000-000000000002`)
    ).toBe('b')
  })
})
