// @vitest-environment happy-dom
// A value the field sets on the editor comes from the draft store, so the editor never saves it
// back: an echo would make another window's draft, or a late-loaded one, a change of this window.
import { createElement, createRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DraftStore from './native-chat-composer-draft-store'
import type * as DraftCache from './native-chat-draft-cache'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { createMemoryNativeChatComposerDraftStorage } from './native-chat-composer-draft-storage'

type Renderer = { drafts: typeof DraftCache; store: typeof DraftStore }

const SCOPE = 'agent-session:s1'
let storage = createMemoryNativeChatComposerDraftStorage()
const loaded: Renderer[] = []

async function open(options: { hydrate?: boolean } = {}): Promise<Renderer> {
  vi.resetModules()
  const storageModule = await import('./native-chat-composer-draft-storage')
  storageModule.setNativeChatComposerDraftStorageForTests(storage)
  const renderer = {
    drafts: await import('./native-chat-draft-cache'),
    store: await import('./native-chat-composer-draft-store')
  }
  loaded.push(renderer)
  if (options.hydrate !== false) {
    await renderer.store.hydrateNativeChatComposerDrafts()
  }
  return renderer
}

/** The editor, plus the field's effect that sets the store's draft on it. */
async function mountEditor(
  renderer: Renderer
): Promise<{ stopSync: () => void; input: () => NativeChatComposerInput; unmount: () => void }> {
  const { NativeChatPromptEditor } = await import('./NativeChatPromptEditor')
  const inputRef = createRef<NativeChatComposerInput>()
  const view = render(
    createElement(NativeChatPromptEditor, {
      scopeKey: SCOPE,
      inputRef,
      initialValue: renderer.drafts.readNativeChatDraftCache(SCOPE),
      disabled: false,
      placeholder: 'Message',
      onChange: () => {},
      onSelect: () => {}
    })
  )
  await vi.waitFor(() => expect(inputRef.current).not.toBeNull())
  const stopSync = renderer.store.subscribeToNativeChatComposerDraft(SCOPE, () => {
    // Like the field's layout effect, after the store change returns.
    queueMicrotask(() => {
      const draft = renderer.drafts.readNativeChatDraftCache(SCOPE)
      if (inputRef.current && inputRef.current.value !== draft) {
        inputRef.current.value = draft
      }
    })
  })
  return { stopSync, input: () => inputRef.current!, unmount: view.unmount }
}

const SKILL_DOCUMENT = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'nativeChatSkill', attrs: { token: '$review' } },
        { type: 'text', text: ' this' }
      ]
    }
  ]
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
})

afterEach(() => {
  cleanup()
  for (const renderer of loaded.splice(0)) {
    renderer.store.clearNativeChatComposerDraftsForTests()
  }
})

describe('the editor and the draft store', () => {
  it('saves nothing when a draft that loads late is set on the editor', async () => {
    storage.drafts.set(SCOPE, { text: 'saved before the restart', images: [], savedAt: 1 })
    const renderer = await open({ hydrate: false })
    const { stopSync, input } = await mountEditor(renderer)
    const write = vi.spyOn(storage, 'write')

    await act(async () => renderer.store.hydrateNativeChatComposerDrafts())
    await act(async () => pause(400))
    await renderer.store.nativeChatComposerDraftWritesSettled()
    stopSync()
    expect(input().value).toBe('saved before the restart')
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps the skill chip when the composer itself changes the text, across a remount', async () => {
    const renderer = await open()
    renderer.drafts.writeNativeChatDraftDocument(SCOPE, '$review this', SKILL_DOCUMENT)
    renderer.store.flushNativeChatComposerDrafts()
    const first = await mountEditor(renderer)
    await vi.waitFor(() =>
      expect(window.document.querySelector('[data-native-chat-skill]')).not.toBeNull()
    )
    // A mention accepted: the composer writes the text, then the field sets it on the editor.
    const next = '$review this @src/a.ts '
    act(() => {
      renderer.drafts.writeNativeChatDraftCache(SCOPE, next)
      first.input().value = next
    })
    await act(async () => pause(400))
    await renderer.store.nativeChatComposerDraftWritesSettled()
    expect(JSON.stringify(storage.drafts.get(SCOPE)?.document ?? null)).toContain('nativeChatSkill')

    first.stopSync()
    first.unmount()
    const second = await mountEditor(renderer)
    await pause(50)
    second.stopSync()
    expect(window.document.querySelector('[data-native-chat-skill]')).not.toBeNull()
  })

  it('lets another window’s send stand, instead of echoing back the draft it showed', async () => {
    const receiving = await open()
    const { stopSync } = await mountEditor(receiving)
    const sending = await open()
    sending.drafts.writeNativeChatDraftCache(SCOPE, 'hello')
    sending.store.flushNativeChatComposerDrafts()
    await act(async () => {
      await vi.waitFor(() => expect(receiving.drafts.readNativeChatDraftCache(SCOPE)).toBe('hello'))
    })

    sending.drafts.writeNativeChatDraftCache(SCOPE, '')
    await sending.store.nativeChatComposerDraftWritesSettled()
    await act(async () => pause(600))
    await receiving.store.nativeChatComposerDraftWritesSettled()
    await act(async () => pause(50))
    stopSync()

    expect(storage.drafts.has(SCOPE)).toBe(false)
    expect(sending.drafts.readNativeChatDraftCache(SCOPE)).toBe('')
    expect(receiving.drafts.readNativeChatDraftCache(SCOPE)).toBe('')
  })

  it('shows a draft that arrives later with its skill chip, from its saved document', async () => {
    const document = SKILL_DOCUMENT
    const receiving = await open()
    const { stopSync } = await mountEditor(receiving)
    const sending = await open()
    sending.drafts.writeNativeChatDraftDocument(SCOPE, '$review this', document)
    sending.store.flushNativeChatComposerDrafts()
    await act(async () => {
      await vi.waitFor(() =>
        expect(receiving.drafts.readNativeChatDraftCache(SCOPE)).toBe('$review this')
      )
    })
    stopSync()

    expect(window.document.querySelector('[data-native-chat-skill]')).not.toBeNull()
    expect(storage.drafts.get(SCOPE)?.document).toEqual(document)
  })
})
