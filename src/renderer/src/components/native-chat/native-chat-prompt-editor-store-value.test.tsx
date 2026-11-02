// @vitest-environment happy-dom
// Store-driven editor updates must not echo back as this window’s edit to another or late-loaded draft.
import { createElement, createRef } from 'react'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DraftStore from './native-chat-composer-draft-store'
import type * as DraftCache from './native-chat-draft-cache'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { createMemoryNativeChatComposerDraftStorage } from './native-chat-composer-draft-storage'
import { promptEditor } from './native-chat-prompt-editor.test-support'

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

beforeEach(() => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
})

afterEach(() => {
  vi.useRealTimers()
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await act(async () => renderer.store.hydrateNativeChatComposerDrafts())
    await act(async () => vi.advanceTimersByTimeAsync(400))
    await renderer.store.nativeChatComposerDraftWritesSettled()
    stopSync()
    expect(input().value).toBe('saved before the restart')
    expect(write).not.toHaveBeenCalled()
  })

  it.each([
    ['insertTypedText', '$review thisReply'],
    ['appendText', '$review this\n\nReply']
  ] as const)(
    'keeps %s key order and saved chips through a quote and remount',
    async (write, expected) => {
      const renderer = await open()
      renderer.drafts.writeNativeChatDraftDocument(SCOPE, '$review this', SKILL_DOCUMENT)
      renderer.store.flushNativeChatComposerDrafts()
      const first = await mountEditor(renderer)
      const input = first.input()
      input.setSelectionRange(input.value.length, input.value.length)
      const { useNativeChatTypedInsertion } = await import('./use-native-chat-typed-insertion')
      const { result } = renderHook(() =>
        useNativeChatTypedInsertion({
          textareaRef: { current: first.input() },
          isComposing: () => false,
          setDraft: (text) => renderer.drafts.writeNativeChatDraftCache(SCOPE, text),
          setCaret: () => {},
          setActiveSuggestion: () => {}
        })
      )
      const editor = promptEditor(screen.getByRole('textbox'))
      act(() => {
        result.current[write]('R')
        editor.view.dispatch(editor.state.tr.insertText('e'))
      })
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
      act(() => editor.view.dispatch(editor.state.tr.insertText('ply')))
      expect([input.value, input.selectionStart]).toEqual([expected, expected.length])
      renderer.store.flushNativeChatComposerDrafts()
      await renderer.store.nativeChatComposerDraftWritesSettled()
      expect(renderer.store.hasUnsavedNativeChatComposerDraftChange(SCOPE)).toBe(false)
      await act(async () => {
        result.current.appendText('> quote\n\n')
        renderer.store.flushNativeChatComposerDrafts()
        await renderer.store.nativeChatComposerDraftWritesSettled()
      })
      first.stopSync()
      first.unmount()
      const second = await mountEditor(renderer)
      await vi.waitFor(() =>
        expect(window.document.querySelector('[data-native-chat-skill]')).not.toBeNull()
      )
      expect(second.input().value).toBe(`${expected}\n\n> quote\n\n`)
      second.stopSync()
    }
  )

  it('lets another window’s send stand, instead of echoing back the draft it showed', async () => {
    const receiving = await open()
    const { stopSync } = await mountEditor(receiving)
    const sending = await open()
    sending.drafts.writeNativeChatDraftCache(SCOPE, 'hello')
    sending.store.flushNativeChatComposerDrafts()
    await act(async () => {
      await vi.waitFor(() => expect(receiving.drafts.readNativeChatDraftCache(SCOPE)).toBe('hello'))
    })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    sending.drafts.writeNativeChatDraftCache(SCOPE, '')
    await sending.store.nativeChatComposerDraftWritesSettled()
    await act(async () => {
      await vi.waitFor(() => expect(receiving.drafts.readNativeChatDraftCache(SCOPE)).toBe(''))
    })
    await act(async () => vi.advanceTimersByTimeAsync(600))
    await receiving.store.nativeChatComposerDraftWritesSettled()
    await act(async () => vi.advanceTimersByTimeAsync(50))
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
