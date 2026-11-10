// @vitest-environment happy-dom
import { useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPendingEditorBuffer } from '../../save/flush/editor-pending-flush'
import { parseIpynb } from './ipynb-parse'
import { useIpynbDocumentEditing } from './useIpynbDocumentEditing'

import { EMPTY_EDITOR_BUFFER_VIEW_INDEX as NO_SHARING } from '@/store/slices/editor/buffers/editor-buffer-views'
import type * as StaleViewEdit from '../../save/flush/editor-stale-view-edit'
import { notifyStaleViewEditRejected } from '../../save/flush/editor-stale-view-edit'
import { discardEditorBuffer } from '../../save/flush/discard-editor-file-changes'

vi.mock('../../save/flush/editor-stale-view-edit', async (importOriginal) => ({
  ...(await importOriginal<typeof StaleViewEdit>()),
  notifyStaleViewEditRejected: vi.fn()
}))

function renderSplitPanes(initialContent: string) {
  let shared = initialContent
  const panes = renderHook(() => {
    const [content, setContent] = useState(initialContent)
    shared = content
    const props = {
      content,
      fileId: 'notebook-a',
      notebook: parseIpynb(content),
      onContentChange: setContent,
      onDirtyStateHint: vi.fn(),
      onDeactivateEditor: vi.fn()
    }
    return { a: useIpynbDocumentEditing(props), b: useIpynbDocumentEditing(props) }
  })
  return { panes, text: () => shared }
}

function notebookContent(firstSource = 'a', secondSource = 'b'): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: 'python' } },
    cells: [
      {
        id: 'a',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [firstSource]
      },
      {
        id: 'b',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [secondSource]
      }
    ]
  })
}

describe('notebook document editing lifecycle', () => {
  const animationFrames = new Map<number, FrameRequestCallback>()
  let nextFrameId = 1

  beforeEach(() => {
    vi.useFakeTimers()
    animationFrames.clear()
    nextFrameId = 1
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const frameId = nextFrameId
        nextFrameId += 1
        animationFrames.set(frameId, callback)
        return frameId
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((frameId: number) => {
        animationFrames.delete(frameId)
      })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('debounces drafts, flushes the latest source, and releases acknowledged drafts', () => {
    const onContentChange = vi.fn()
    const onDirtyStateHint = vi.fn()
    const onDeactivateEditor = vi.fn()
    const initialContent = notebookContent()
    const hook = renderHook(
      ({ content }: { content: string }) =>
        useIpynbDocumentEditing({
          content,
          fileId: 'notebook-a',
          notebook: parseIpynb(content),
          onContentChange,
          onDirtyStateHint,
          onDeactivateEditor
        }),
      { initialProps: { content: initialContent } }
    )

    act(() => {
      hook.result.current.updateCellSource(0, 'first draft')
      hook.result.current.updateCellSource(0, 'latest draft')
      vi.advanceTimersByTime(399)
    })
    expect(onDirtyStateHint).toHaveBeenCalledTimes(2)
    expect(onContentChange).not.toHaveBeenCalled()

    act(() => flushPendingEditorBuffer(NO_SHARING, 'notebook-a'))
    expect(onContentChange).toHaveBeenCalledTimes(1)
    const committedContent = onContentChange.mock.calls[0]?.[0] as string
    expect(parseIpynb(committedContent).cells[0]?.source).toBe('latest draft')

    hook.rerender({ content: committedContent })
    expect(Object.hasOwn(hook.result.current.sourceDrafts, 'a')).toBe(false)

    const externalContent = notebookContent('external source')
    hook.rerender({ content: externalContent })
    expect(Object.hasOwn(hook.result.current.sourceDrafts, 'a')).toBe(false)
  })

  it('drops pending discarded cells and accepts typing begun afterwards', async () => {
    const content = notebookContent()
    const committed: string[] = []
    const hook = renderHook(() =>
      useIpynbDocumentEditing({
        content,
        fileId: 'discard-notebook',
        notebook: parseIpynb(content),
        onContentChange: (text) => committed.push(text),
        onDirtyStateHint: vi.fn(),
        onDeactivateEditor: vi.fn()
      })
    )
    await act(async () => {
      hook.result.current.updateCellSource(0, 'discarded draft')
      const release = await discardEditorBuffer('discard-notebook')
      release()
    })
    expect(parseIpynb(committed.at(-1)!).cells[0]?.source).toBe('a')
    act(() => {
      hook.result.current.updateCellSource(0, 'new draft')
      flushPendingEditorBuffer(NO_SHARING, 'discard-notebook')
    })
    expect(parseIpynb(committed.at(-1)!).cells[0]?.source).toBe('new draft')
  })

  it('does not republish unchanged text when flushed with no pending typing', () => {
    const onContentChange = vi.fn()
    const content = notebookContent()
    const hook = renderHook(() =>
      useIpynbDocumentEditing({
        content,
        fileId: 'notebook-a',
        notebook: parseIpynb(content),
        onContentChange,
        onDirtyStateHint: vi.fn(),
        onDeactivateEditor: vi.fn()
      })
    )

    act(() => {
      hook.result.current.updateCellSource(0, 'draft')
      vi.advanceTimersByTime(400)
      expect(onContentChange).toHaveBeenCalledOnce()
      // The committed draft awaits acknowledgement; republishing this view's text could overwrite a newer view's.
      flushPendingEditorBuffer(NO_SHARING, 'notebook-a')
    })
    expect(onContentChange).toHaveBeenCalledOnce()
  })

  it('flushes drafts before structural work and cancels queued work on detach', () => {
    const onContentChange = vi.fn()
    const onDeactivateEditor = vi.fn()
    const content = notebookContent()
    const { result } = renderHook(() =>
      useIpynbDocumentEditing({
        content,
        fileId: 'notebook-a',
        notebook: parseIpynb(content),
        onContentChange,
        onDirtyStateHint: vi.fn(),
        onDeactivateEditor
      })
    )

    act(() => {
      result.current.updateCellSource(0, 'edited before move')
      result.current.moveCell(0, 1)
    })
    expect(onDeactivateEditor).toHaveBeenCalledOnce()
    expect(onContentChange).toHaveBeenCalledTimes(1)
    expect(parseIpynb(onContentChange.mock.calls[0]?.[0] as string).cells[0]?.source).toBe(
      'edited before move'
    )
    expect(animationFrames.size).toBe(1)

    const [[frameId, frameCallback]] = [...animationFrames.entries()]
    animationFrames.delete(frameId)
    act(() => frameCallback(0))
    const movedNotebook = parseIpynb(onContentChange.mock.calls[1]?.[0] as string)
    expect(movedNotebook.cells.map((cell) => cell.id)).toEqual(['b', 'a'])
    expect(movedNotebook.cells[1]?.source).toBe('edited before move')

    act(() => result.current.deleteCell(0))
    expect(animationFrames.size).toBe(1)
    act(() => result.current.setRootRef(null))
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(animationFrames.size).toBe(0)
  })

  it('rejects a split pane draft typed against text the other pane has since replaced', () => {
    vi.mocked(notifyStaleViewEditRejected).mockClear()
    const { panes, text } = renderSplitPanes(notebookContent())

    act(() => {
      panes.result.current.b.updateCellSource(0, 'pane b edit')
      panes.result.current.a.updateCellSource(0, 'pane a edit')
      panes.result.current.a.flushSourceDrafts()
    })
    expect(parseIpynb(text()).cells[0]?.source).toBe('pane a edit')

    // Pane B's delayed commit was based on the original text; it must not overwrite pane A.
    act(() => vi.advanceTimersByTime(400))
    expect(parseIpynb(text()).cells[0]?.source).toBe('pane a edit')
    expect(notifyStaleViewEditRejected).toHaveBeenCalledOnce()
    expect(panes.result.current.b.sourceDrafts).toEqual({})

    act(() => {
      panes.result.current.b.updateCellSource(1, 'pane b retry')
      vi.advanceTimersByTime(400)
    })
    const notebook = parseIpynb(text())
    expect(notebook.cells.map((cell) => cell.source)).toEqual(['pane a edit', 'pane b retry'])
    expect(notifyStaleViewEditRejected).toHaveBeenCalledOnce()
  })

  it('merges split pane drafts on different cells onto the latest notebook', () => {
    vi.mocked(notifyStaleViewEditRejected).mockClear()
    const { panes, text } = renderSplitPanes(notebookContent())

    act(() => {
      panes.result.current.b.updateCellSource(1, 'pane b edit')
      panes.result.current.a.updateCellSource(0, 'pane a edit')
      panes.result.current.a.flushSourceDrafts()
    })
    act(() => vi.advanceTimersByTime(400))

    const notebook = parseIpynb(text())
    expect(notebook.cells.map((cell) => cell.source)).toEqual(['pane a edit', 'pane b edit'])
    expect(notifyStaleViewEditRejected).not.toHaveBeenCalled()
  })

  it('drops a draft silently once the other pane publishes the same text', () => {
    vi.mocked(notifyStaleViewEditRejected).mockClear()
    const { panes, text } = renderSplitPanes(notebookContent())

    act(() => {
      panes.result.current.b.updateCellSource(0, 'same edit')
      panes.result.current.a.updateCellSource(0, 'same edit')
      panes.result.current.a.flushSourceDrafts()
    })
    expect(panes.result.current.b.sourceDrafts).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
    act(() => panes.result.current.b.flushSourceDrafts())
    act(() => vi.advanceTimersByTime(400))
    expect(notifyStaleViewEditRejected).not.toHaveBeenCalled()

    act(() => {
      panes.result.current.b.updateCellSource(0, 'same edit, then more')
      vi.advanceTimersByTime(400)
    })
    expect(parseIpynb(text()).cells[0]?.source).toBe('same edit, then more')
    expect(notifyStaleViewEditRejected).not.toHaveBeenCalled()
  })

  it('commits pending drafts when focus leaves the notebook so the next view sees them', () => {
    const onContentChange = vi.fn<(content: string) => void>()
    const content = notebookContent()
    const { result } = renderHook(() =>
      useIpynbDocumentEditing({
        content,
        fileId: 'notebook-a',
        notebook: parseIpynb(content),
        onContentChange,
        onDirtyStateHint: vi.fn(),
        onDeactivateEditor: vi.fn()
      })
    )
    const root = document.createElement('div')
    const inside = root.appendChild(document.createElement('input'))
    const blurTo = (relatedTarget: EventTarget | null) =>
      result.current.flushOnFocusLeave({ currentTarget: root, relatedTarget })

    act(() => result.current.updateCellSource(0, 'typed'))
    act(() => blurTo(inside))
    expect(onContentChange).not.toHaveBeenCalled()
    act(() => blurTo(document.body))
    const [committed = ''] = onContentChange.mock.calls[0] ?? []
    expect(parseIpynb(committed).cells[0]?.source).toBe('typed')
  })
})
