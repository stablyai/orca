// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  useNativeChatAnnotationHighlights,
  useNativeChatAnnotations
} from './use-native-chat-annotations'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('native chat annotation hooks', () => {
  it('updates all subscribers, survives remount and switches scopes without leaking notes', () => {
    const { result, rerender, unmount } = renderHook(
      ({ scope }: { scope: string | undefined }) => useNativeChatAnnotations(scope),
      { initialProps: { scope: 'hook-a' } }
    )
    const other = renderHook(() => useNativeChatAnnotations('hook-a'))
    act(() => {
      result.current.add({ quote: 'words', messageId: 'a', startOffset: 0 }, 'explain')
    })
    const note = result.current.notes[0]
    expect(other.result.current.notes).toEqual([note])
    rerender({ scope: 'hook-b' })
    expect(result.current.notes).toEqual([])
    act(() => {
      result.current.clear()
    })
    expect(other.result.current.notes).toEqual([note])
    unmount()
    const remount = renderHook(() => useNativeChatAnnotations('hook-a'))
    expect(remount.result.current.notes).toEqual([note])
    if (!note) {
      throw new Error('Missing note')
    }
    act(() => {
      remount.result.current.update(note.id, 'new comment')
    })
    expect(other.result.current.notes[0]?.comment).toBe('new comment')
    act(() => {
      remount.result.current.remove(note.id)
    })
    expect(other.result.current.notes).toEqual([])
  })

  it('keeps a failed save visible across remount and clears the error after retry', () => {
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    const first = renderHook(() => useNativeChatAnnotations('hook-unsaved'))
    act(() => {
      first.result.current.add({ quote: 'words', messageId: 'a', startOffset: 0 }, 'keep')
    })
    const notes = first.result.current.notes
    first.unmount()
    const second = renderHook(() => useNativeChatAnnotations('hook-unsaved'))
    expect(second.result.current.notes).toEqual(notes)
    expect(second.result.current.persistenceError).toBe('full')
    write.mockRestore()
    act(() => {
      expect(second.result.current.retryPersistence()).toBe(true)
    })
    expect(second.result.current.persistenceError).toBeUndefined()
  })

  it('keeps editor drafts in their own scopes across switches, other subscribers and remounts', () => {
    const firstDraft = {
      anchor: { quote: 'first', messageId: 'a', startOffset: 0 },
      comment: 'keep a'
    }
    const secondDraft = {
      anchor: { quote: 'second', messageId: 'b', startOffset: 7 },
      comment: 'keep b'
    }
    const first = renderHook(({ scope }) => useNativeChatAnnotations(scope), {
      initialProps: { scope: 'editor-hook-a' }
    })
    const other = renderHook(() => useNativeChatAnnotations('editor-hook-a'))
    act(() => {
      first.result.current.setEditor(firstDraft)
    })
    expect(other.result.current.editor).toMatchObject(firstDraft)
    first.rerender({ scope: 'editor-hook-b' })
    expect(first.result.current.editor).toBeUndefined()
    act(() => {
      first.result.current.setEditor(secondDraft)
    })
    expect(other.result.current.editor).toMatchObject(firstDraft)
    first.rerender({ scope: 'editor-hook-a' })
    expect(first.result.current.editor).toMatchObject(firstDraft)
    first.unmount()
    const remount = renderHook(() => useNativeChatAnnotations('editor-hook-b'))
    expect(remount.result.current.editor).toMatchObject(secondDraft)
  })

  it('retains editor edits after failed writes and retries the whole snapshot after remount', async () => {
    const first = renderHook(() => useNativeChatAnnotations('editor-hook-unsaved'))
    act(() => {
      first.result.current.add({ quote: 'words', messageId: 'reply', startOffset: 0 }, 'saved')
    })
    const notes = first.result.current.notes
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    const draft = {
      anchor: { quote: 'words', messageId: 'reply', startOffset: 0 },
      comment: '  final draft\n'
    }
    act(() => {
      expect(first.result.current.setEditor({ ...draft, comment: '' })).toBe(true)
      expect(first.result.current.setEditor(draft)).toBe(true)
    })
    const savedDraft = first.result.current.editor
    first.unmount()
    const remount = renderHook(() => useNativeChatAnnotations('editor-hook-unsaved'))
    expect(remount.result.current.editor).toEqual(savedDraft)
    expect(remount.result.current.notes).toEqual(notes)
    expect(remount.result.current.persistenceError).toBe('full')
    write.mockRestore()
    act(() => {
      expect(remount.result.current.retryPersistence()).toBe(true)
    })
    expect(remount.result.current.persistenceError).toBeUndefined()
    vi.resetModules()
    const fresh = await import('./native-chat-annotations-store')
    expect(fresh.getNativeChatAnnotationsStore('editor-hook-unsaved').getSnapshot()).toEqual({
      notes,
      editor: savedDraft
    })
  })

  it('reattaches highlights to virtual rows, isolates instances and cleans up without changing text', async () => {
    class TestHighlight extends Set<Range> {}
    const registry = new Map<string, TestHighlight>()
    vi.stubGlobal('Highlight', TestHighlight)
    vi.stubGlobal('CSS', { highlights: registry })
    const root = document.createElement('div')
    document.body.append(root)
    const notes = [
      {
        id: 'note',
        quote: 'words',
        messageId: 'reply',
        startOffset: 6,
        comment: 'explain',
        createdAt: 1
      }
    ]
    const ref = { current: root }
    const first = renderHook(
      ({ enabled }) => useNativeChatAnnotationHighlights(ref, notes, enabled),
      {
        initialProps: { enabled: true }
      }
    )
    const second = renderHook(() => useNativeChatAnnotationHighlights(ref, notes))
    expect(first.result.current).not.toBe(second.result.current)
    const row = document.createElement('div')
    row.dataset.nativeChatMessageId = 'reply'
    const source = document.createElement('p')
    source.dataset.nativeChatQuoteSource = ''
    source.textContent = 'hello words'
    row.append(source)
    root.append(row)
    await waitFor(() => expect(registry.get(first.result.current)?.size).toBe(1))
    expect(registry.get(first.result.current)?.values().next().value?.toString()).toBe('words')
    expect(source.textContent).toBe('hello words')
    expect(source.childNodes).toHaveLength(1)
    row.remove()
    await waitFor(() => expect(registry.has(first.result.current)).toBe(false))
    const replacement = row.cloneNode(true)
    root.append(replacement)
    await waitFor(() => expect(registry.get(first.result.current)?.size).toBe(1))
    first.rerender({ enabled: false })
    expect(registry.has(first.result.current)).toBe(false)
    expect(registry.has(second.result.current)).toBe(true)
    second.unmount()
    expect(registry.size).toBe(0)
  })
})
