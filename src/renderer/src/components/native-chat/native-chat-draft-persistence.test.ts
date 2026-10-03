// A half-typed chat message survives quitting Orca. Typing is saved after a pause; the clear at
// send and any text put back are saved at once, so a crash right after Enter cannot bring back
// text the host already took.

// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from './native-chat-composer-scope-cache'
import type * as NativeChatDraftCache from './native-chat-draft-cache'
import {
  installHeldNativeChatDrafts,
  installLocalStorageNativeChatDrafts
} from './native-chat-draft-store.test-support'

const PREFIX = 'orca:nativeChatComposerDraft:v1:'
const SCOPE = 'structured-agent-session-s1:pane'

type DraftCache = typeof NativeChatDraftCache

/** A fresh renderer: module memory is gone, only localStorage remains. */
async function relaunch(): Promise<DraftCache> {
  vi.resetModules()
  return import('./native-chat-draft-cache')
}

function saved(scopeKey: string): { text: string; attachments: unknown[] } | null {
  const raw = localStorage.getItem(`${PREFIX}${encodeURIComponent(scopeKey)}`)
  return raw ? JSON.parse(raw) : null
}

let cache: DraftCache

beforeEach(async () => {
  vi.useFakeTimers()
  localStorage.clear()
  installLocalStorageNativeChatDrafts()
  cache = await relaunch()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cache.clearNativeChatDraftCacheForTests()
  vi.useRealTimers()
})

/** Storage that reads fine but refuses every write, as a full quota does. */
function fullStorage(): Storage {
  const real = localStorage
  return {
    get length() {
      return real.length
    },
    key: (index) => real.key(index),
    getItem: (key) => real.getItem(key),
    clear: () => real.clear(),
    removeItem: () => {
      throw new DOMException('quota', 'QuotaExceededError')
    },
    setItem: () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
  }
}

describe('composer draft persistence', () => {
  it('restores typed text and attachments after a relaunch', async () => {
    cache.writeNativeChatDraftCache(SCOPE, 'half typed', 'after-pause')
    cache.addNativeChatDraftAttachments(SCOPE, [
      { id: 'a1', path: '/tmp/shot.png', connectionId: 'ssh-1' }
    ])
    vi.advanceTimersByTime(300)

    const next = await relaunch()

    expect(next.readNativeChatDraftCache(SCOPE)).toBe('half typed')
    expect(next.readNativeChatDraftAttachments(SCOPE)).toEqual([
      { id: 'a1', path: '/tmp/shot.png', connectionId: 'ssh-1' }
    ])
  })

  // Chips saved before their location was recorded must still load, as unknown.
  it("restores each image chip's location, and loads a chip saved without one", async () => {
    localStorage.setItem(
      `${PREFIX}${encodeURIComponent(SCOPE)}`,
      JSON.stringify({
        text: '',
        attachments: [
          { id: 'old', path: '/old.png' },
          { id: 'runtime', path: '/srv/a.png', location: 'runtime' },
          { id: 'odd', path: '/odd.png', location: 'mars' }
        ]
      })
    )

    const next = await relaunch()

    expect(next.readNativeChatDraftAttachments(SCOPE)).toEqual([
      { id: 'old', path: '/old.png' },
      { id: 'runtime', path: '/srv/a.png', location: 'runtime' },
      { id: 'odd', path: '/odd.png' }
    ])
  })

  it('saves typing only after the pause', () => {
    cache.writeNativeChatDraftCache(SCOPE, 'h', 'after-pause')
    cache.writeNativeChatDraftCache(SCOPE, 'he', 'after-pause')
    expect(saved(SCOPE)).toBeNull()

    vi.advanceTimersByTime(299)
    expect(saved(SCOPE)).toBeNull()
    vi.advanceTimersByTime(1)
    expect(saved(SCOPE)?.text).toBe('he')
  })

  it.each([
    ['beforeunload', () => window.dispatchEvent(new Event('beforeunload'))],
    ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
    [
      'the page becoming hidden',
      () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
      }
    ]
  ])('flushes pending typing on %s', (_case, hide) => {
    cache.writeNativeChatDraftCache(SCOPE, 'about to quit', 'after-pause')
    expect(saved(SCOPE)).toBeNull()

    hide()

    expect(saved(SCOPE)?.text).toBe('about to quit')
  })

  it('writes the clear at send at once, cancelling the pending typing write', async () => {
    cache.writeNativeChatDraftCache(SCOPE, 'sent text', 'after-pause')
    vi.advanceTimersByTime(300)
    cache.writeNativeChatDraftCache(SCOPE, 'sent text, edited', 'after-pause')

    // Enter: the composer clears; a crash follows before any timer runs.
    cache.writeNativeChatDraftCache(SCOPE, '', 'now')

    expect(saved(SCOPE)).toBeNull()
    const next = await relaunch()
    expect(next.readNativeChatDraftCache(SCOPE)).toBe('')
  })

  // The put-back is not the sent text; a crash before the typing delay must not restore the latter.
  it('writes a clear at once when a put-back made mid-composition rides along', async () => {
    const { useNativeChatDraft } = await import('./use-native-chat-draft')
    cache.writeNativeChatDraftCache(SCOPE, 'sent text', 'after-pause')
    vi.advanceTimersByTime(300)
    const { result } = renderHook(() => useNativeChatDraft(SCOPE, () => true))
    act(() => {
      cache.appendNativeChatDraftNow(SCOPE, { text: 'withdrawn' })
    })

    act(() => result.current.setDraft(''))

    expect(saved(SCOPE)?.text).toBe('withdrawn')
  })

  it("shows a write that lands between a view's render and its subscription", async () => {
    const { useNativeChatDraft } = await import('./use-native-chat-draft')
    const { result } = renderHook(() => {
      const view = useNativeChatDraft(SCOPE, () => false)
      useLayoutEffect(
        () => cache.writeNativeChatDraftCache(SCOPE, 'written meanwhile', 'after-pause'),
        []
      )
      return view
    })

    expect(result.current.draft).toBe('written meanwhile')
  })

  it("forgets a closed tab's input-line seeds, on disk too, and keeps other tabs'", async () => {
    const seed = { agent: 'claude' as const, text: 'issue link', createdAt: 1 }
    cache.writeNativeChatDraftTuiInputSeed('pane:tab-1:a', seed)
    cache.writeNativeChatDraftTuiInputSeed('pane:tab-2:a', seed)

    cache.forgetNativeChatTuiInputSeeds('tab-1')

    const next = await relaunch()
    expect(next.readNativeChatDraftTuiInputSeed('pane:tab-1:a')).toBeUndefined()
    expect(next.readNativeChatDraftTuiInputSeed('pane:tab-2:a')).toEqual(seed)
  })

  it('writes text put back at once and reports that it reached disk', async () => {
    const result = cache.appendNativeChatDraftNow(SCOPE, {
      text: 'withdrawn',
      attachments: [{ id: 'w1', path: '/tmp/w.png' }]
    })

    await expect(result).resolves.toBe('persisted')
    expect(saved(SCOPE)).toMatchObject({
      text: 'withdrawn',
      attachments: [{ id: 'w1', path: '/tmp/w.png' }]
    })
    const next = await relaunch()
    expect(next.readNativeChatDraftCache(SCOPE)).toBe('withdrawn')
  })

  it('restores only into an empty composer', async () => {
    cache.writeNativeChatDraftCache(SCOPE, 'typed since', 'after-pause')

    await expect(cache.restoreNativeChatDraftIfEmpty(SCOPE, { text: 'refused' })).resolves.toBe(
      'composer-not-empty'
    )
    expect(cache.readNativeChatDraftCache(SCOPE)).toBe('typed since')

    cache.writeNativeChatDraftCache(SCOPE, '', 'now')
    await expect(cache.restoreNativeChatDraftIfEmpty(SCOPE, { text: 'refused' })).resolves.toBe(
      'persisted'
    )
    expect(saved(SCOPE)?.text).toBe('refused')
  })

  it('keeps drafts for every chat apart', async () => {
    cache.appendNativeChatDraftNow('chat-a', { text: 'for a' })
    cache.appendNativeChatDraftNow('chat-b', { text: 'for b' })

    const next = await relaunch()

    expect(next.readNativeChatDraftCache('chat-a')).toBe('for a')
    expect(next.readNativeChatDraftCache('chat-b')).toBe('for b')
  })

  it('names a structured chat by its session, whichever pane shows it', async () => {
    const before = cache.nativeChatDraftKey({ sessionId: 's1', paneKey: 'tab-1:leaf-1' })
    cache.appendNativeChatDraftNow(before, { text: 'follows the chat' })

    const next = await relaunch()
    const after = next.nativeChatDraftKey({ sessionId: 's1', paneKey: 'tab-9:leaf-9' })

    expect(next.readNativeChatDraftCache(after)).toBe('follows the chat')
    expect(next.nativeChatDraftKey({ paneKey: 'tab-1:leaf-1' })).not.toBe(before)
  })

  it('keeps the draft in memory and reports memory-only when storage throws', async () => {
    vi.stubGlobal('localStorage', fullStorage())

    expect(() => cache.writeNativeChatDraftCache(SCOPE, 'typed', 'after-pause')).not.toThrow()
    expect(() => vi.advanceTimersByTime(300)).not.toThrow()
    await expect(cache.appendNativeChatDraftNow(SCOPE, { text: 'back' })).resolves.toBe(
      'memory-only'
    )
    expect(cache.readNativeChatDraftCache(SCOPE)).toBe('typed\n\nback')
  })

  it('works without storage at all', async () => {
    vi.stubGlobal('localStorage', undefined)
    const next = await relaunch()

    next.writeNativeChatDraftCache(SCOPE, 'typed', 'after-pause')
    await expect(next.appendNativeChatDraftNow(SCOPE, { text: 'back' })).resolves.toBe(
      'memory-only'
    )
    expect(next.readNativeChatDraftCache(SCOPE)).toBe('typed\n\nback')
  })

  it('bounds the saved drafts, dropping the least recently written', async () => {
    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 5
    for (let index = 0; index < total; index += 1) {
      vi.setSystemTime(1_000 + index)
      cache.appendNativeChatDraftNow(`scope-${index}`, { text: `draft-${index}` })
    }

    expect(saved('scope-0')).toBeNull()
    expect(saved(`scope-${total - 1}`)?.text).toBe(`draft-${total - 1}`)
    const next = await relaunch()
    expect(next.readNativeChatDraftCache('scope-4')).toBe('')
    expect(next.readNativeChatDraftCache('scope-5')).toBe('draft-5')
  })

  it('prunes saved drafts past the bound when they load', async () => {
    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 3
    for (let index = 0; index < total; index += 1) {
      localStorage.setItem(
        `${PREFIX}scope-${index}`,
        JSON.stringify({ text: `draft-${index}`, attachments: [], savedAt: index })
      )
    }
    localStorage.setItem(`${PREFIX}broken`, '{not json')

    const next = await relaunch()

    expect(next.readNativeChatDraftCache('scope-2')).toBe('')
    expect(next.readNativeChatDraftCache('scope-3')).toBe('draft-3')
    expect(saved('scope-0')).toBeNull()
    expect(localStorage.getItem(`${PREFIX}broken`)).toBeNull()
  })

  it('never drops a draft a view is showing, however many newer drafts are written', () => {
    cache.appendNativeChatDraftNow('open-chat', { text: 'still open' })
    const unsubscribe = cache.subscribeToNativeChatDraft('open-chat', () => {})
    for (let index = 0; index < NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 5; index += 1) {
      cache.appendNativeChatDraftNow(`scope-${index}`, { text: `draft-${index}` })
    }

    expect(cache.readNativeChatDraftCache('open-chat')).toBe('still open')
    expect(saved('open-chat')?.text).toBe('still open')
    expect(saved('scope-0')).toBeNull()
    unsubscribe()
  })
})

describe('a draft dies with its chat', () => {
  const chats = {
    session: { sessionId: 's1', paneKey: 'tab-1:leaf-1' },
    pane: { paneKey: 'tab-2:leaf-a' },
    otherPane: { paneKey: 'tab-2:leaf-b' },
    otherTab: { paneKey: 'tab-22:leaf-a' }
  }

  beforeEach(() => {
    for (const chat of Object.values(chats)) {
      cache.appendNativeChatDraftNow(cache.nativeChatDraftKey(chat), {
        text: 'unsent',
        attachments: [{ id: 'i1', path: '/tmp/i.png' }]
      })
    }
  })

  it('deletes a closed session or pane draft, in memory and on disk', async () => {
    const shown = vi.fn()
    cache.subscribeToNativeChatDraft(cache.nativeChatDraftKey(chats.session), shown)

    cache.discardNativeChatDrafts({ sessionIds: ['s1'], paneKeys: ['tab-2:leaf-a'] })

    expect(shown).toHaveBeenCalled()
    expect(cache.readNativeChatDraftCache(cache.nativeChatDraftKey(chats.session))).toBe('')
    expect(saved(cache.nativeChatDraftKey(chats.pane))).toBeNull()
    const next = await relaunch()
    expect(next.readNativeChatDraftCache(next.nativeChatDraftKey(chats.session))).toBe('')
    expect(next.readNativeChatDraftAttachments(next.nativeChatDraftKey(chats.pane))).toEqual([])
    expect(next.readNativeChatDraftCache(next.nativeChatDraftKey(chats.otherPane))).toBe('unsent')
  })

  it('forgets the sends of a chat that ended', () => {
    const key = cache.nativeChatDraftKey({ sessionId: 's-ended', paneKey: '' })
    cache.clearNativeChatDraftForSend(key, () => {})

    cache.discardNativeChatDrafts({ sessionIds: ['s-ended'] })

    expect(cache.nativeChatSendsAwaitingHostForTests(key)).toBe(0)
  })

  it("deletes every pane's draft of a closed terminal tab, and no other tab's", async () => {
    cache.discardNativeChatDrafts({ terminalTabIds: ['tab-2'] })

    const next = await relaunch()
    expect(next.readNativeChatDraftCache(next.nativeChatDraftKey(chats.pane))).toBe('')
    expect(next.readNativeChatDraftCache(next.nativeChatDraftKey(chats.otherPane))).toBe('')
    expect(next.readNativeChatDraftCache(next.nativeChatDraftKey(chats.otherTab))).toBe('unsent')
    expect(next.readNativeChatDraftCache(next.nativeChatDraftKey(chats.session))).toBe('unsent')
  })
})

describe('another window of the web client', () => {
  function otherWindowSaves(scopeKey: string, value: string | null): void {
    const key = `${PREFIX}${encodeURIComponent(scopeKey)}`
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
  }

  it("shows another tab's draft, and its clear at send, instead of re-saving sent text", () => {
    cache.writeNativeChatDraftCache(SCOPE, 'deploy to prod', 'after-pause')
    vi.advanceTimersByTime(300)
    const shown = vi.fn()
    cache.subscribeToNativeChatDraft(SCOPE, shown)

    otherWindowSaves(SCOPE, null)
    expect(cache.readNativeChatDraftCache(SCOPE)).toBe('')
    expect(shown).toHaveBeenCalledTimes(1)

    otherWindowSaves(SCOPE, JSON.stringify({ text: 'from the other tab', attachments: [] }))
    expect(cache.readNativeChatDraftCache(SCOPE)).toBe('from the other tab')
  })

  // This tab hears other tabs only once a chat first reads drafts, so that read must be live.
  it("misses no send another tab made before this tab's chat first read its draft", async () => {
    cache.writeNativeChatDraftCache(SCOPE, 'deploy to prod', 'now')
    const next = await relaunch()
    await (await import('./native-chat-draft-storage')).preloadNativeChatDrafts()

    localStorage.removeItem(`${PREFIX}${encodeURIComponent(SCOPE)}`)

    expect(next.readNativeChatDraftCache(SCOPE)).toBe('')
  })

  it("keeps this tab's unsaved typing over another tab's write", () => {
    cache.writeNativeChatDraftCache(SCOPE, 'typing here', 'after-pause')

    otherWindowSaves(SCOPE, JSON.stringify({ text: 'older', attachments: [] }))

    expect(cache.readNativeChatDraftCache(SCOPE)).toBe('typing here')
  })
})

// A send goes ahead without a saved clear only when saving failed or was slow; say so in the log.
describe('a clear that was not saved before the send went on', () => {
  it('is logged once with its chat and why, never its text', async () => {
    const writes = installHeldNativeChatDrafts()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cache.writeNativeChatDraftCache(SCOPE, 'secret plan', 'now')
    writes.shift()?.settle('persisted')
    cache.writeNativeChatDraftCache(SCOPE, '', 'now')

    const waited = cache.awaitNativeChatDraftWritten(SCOPE)
    await vi.advanceTimersByTimeAsync(250)
    await waited

    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.any(String), { scopeKey: SCOPE, reason: 'timed out' })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret plan')
  })

  it('is logged when the store refused the clear', async () => {
    const writes = installHeldNativeChatDrafts()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cache.writeNativeChatDraftCache(SCOPE, '', 'now')

    const waited = cache.awaitNativeChatDraftWritten(SCOPE)
    writes.forEach((write) => write.settle('failed'))
    await waited

    expect(warn).toHaveBeenCalledWith(expect.any(String), { scopeKey: SCOPE, reason: 'failed' })
  })

  it('is not logged when the browser has no storage to save to', async () => {
    vi.stubGlobal('localStorage', undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cache.writeNativeChatDraftCache(SCOPE, '', 'now')

    await cache.awaitNativeChatDraftWritten(SCOPE)

    expect(warn).not.toHaveBeenCalled()
  })

  it('is not logged when it was saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cache.writeNativeChatDraftCache(SCOPE, '', 'now')

    await cache.awaitNativeChatDraftWritten(SCOPE)

    expect(warn).not.toHaveBeenCalled()
  })
})
