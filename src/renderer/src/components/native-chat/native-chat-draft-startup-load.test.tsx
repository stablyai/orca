// @vitest-environment happy-dom
// A chat's saved draft is in the composer on its first paint after a relaunch: startup loads the
// drafts before the session hydrates and any chat mounts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedNativeChatDraft } from '../../../../shared/native-chat-draft-record'
import { installNativeChatDrafts } from './native-chat-draft-store.test-support'

const SAVED: SavedNativeChatDraft[] = [
  { scopeKey: 'session:s1', draft: { text: 'half typed', attachments: [] } }
]

async function relaunch() {
  vi.resetModules()
  const storage = await import('./native-chat-draft-storage')
  const { useNativeChatDraft } = await import('./use-native-chat-draft')
  return { storage, useNativeChatDraft }
}

beforeEach(() => {
  installNativeChatDrafts({
    load: vi.fn(async () => SAVED),
    loadSync: vi.fn(() => SAVED),
    write: vi.fn(async () => 'persisted' as const)
  })
})

afterEach(() => cleanup())

describe('saved drafts at startup', () => {
  it('shows a chat its saved draft on the first render, from the startup load', async () => {
    const { storage, useNativeChatDraft } = await relaunch()
    await storage.preloadNativeChatDrafts()

    const firstRenders: string[] = []
    renderHook(() => {
      const { draft } = useNativeChatDraft('session:s1', () => false)
      firstRenders.push(draft)
    })

    expect(firstRenders[0]).toBe('half typed')
    expect(window.api.nativeChat.drafts.loadSync).not.toHaveBeenCalled()
  })

  it('reads the drafts synchronously when a chat mounts before the startup load returned', async () => {
    const { useNativeChatDraft } = await relaunch()

    const { result } = renderHook(() => useNativeChatDraft('session:s1', () => false))

    expect(result.current.draft).toBe('half typed')
    expect(window.api.nativeChat.drafts.loadSync).toHaveBeenCalledOnce()
  })

  it('reads the drafts synchronously when the startup load fails, without failing startup', async () => {
    installNativeChatDrafts({
      load: async () => {
        throw new Error('no reply')
      },
      loadSync: () => SAVED,
      write: async () => 'persisted'
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { storage, useNativeChatDraft } = await relaunch()

    await expect(storage.preloadNativeChatDrafts()).resolves.toBeUndefined()
    const { result } = renderHook(() => useNativeChatDraft('session:s1', () => false))
    expect(result.current.draft).toBe('half typed')
  })

  it('loads the drafts before the session hydrates', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/app-shell/use-app-startup-hydration.ts'),
      'utf8'
    )
    const loadStart = source.indexOf("'native-chat-drafts-load'")
    const loadAwait = source.indexOf('await draftsPromise')
    const hydrate = source.indexOf("'hydrate-session-stores'")

    expect(loadStart).toBeGreaterThanOrEqual(0)
    expect(loadStart).toBeLessThan(source.indexOf("'session-get'"))
    expect(loadAwait).toBeGreaterThan(loadStart)
    expect(loadAwait).toBeLessThan(hydrate)
  })
})
