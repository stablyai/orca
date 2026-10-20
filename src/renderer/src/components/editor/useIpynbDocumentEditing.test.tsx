// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPendingEditorChange } from './editor-pending-flush'
import { parseIpynb } from './ipynb-parse'
import { useIpynbDocumentEditing } from './useIpynbDocumentEditing'

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

    act(() => flushPendingEditorChange('notebook-a'))
    expect(onContentChange).toHaveBeenCalledTimes(1)
    const committedContent = onContentChange.mock.calls[0]?.[0] as string
    expect(parseIpynb(committedContent).cells[0]?.source).toBe('latest draft')

    hook.rerender({ content: committedContent })
    expect(Object.hasOwn(hook.result.current.sourceDrafts, 'a')).toBe(false)

    const externalContent = notebookContent('external source')
    hook.rerender({ content: externalContent })
    expect(Object.hasOwn(hook.result.current.sourceDrafts, 'a')).toBe(false)
  })

  it('two tabs of one notebook editing different cells keep both cells when both flush', () => {
    // The shared record's draft: every tab's commit lands here at once, as the store fans it out.
    let shared: string | undefined
    const initial = notebookContent()
    const mount = (fileId: string) =>
      renderHook(() =>
        useIpynbDocumentEditing({
          content: initial,
          fileId,
          notebook: parseIpynb(initial),
          onContentChange: (next) => {
            shared = next
          },
          onDirtyStateHint: vi.fn(),
          onDeactivateEditor: vi.fn(),
          readSharedContent: () => shared
        })
      )
    const tabA = mount('notebook-tab-a')
    const tabB = mount('notebook-tab-b')

    act(() => {
      tabA.result.current.updateCellSource(0, 'edited in A')
      tabB.result.current.updateCellSource(1, 'edited in B')
    })
    // Hot exit flushes both tabs before either re-renders with the other's commit.
    act(() => {
      flushPendingEditorChange('notebook-tab-a')
      flushPendingEditorChange('notebook-tab-b')
    })

    const cells = parseIpynb(shared ?? '').cells.map((cell) => cell.source)
    expect(cells).toEqual(['edited in A', 'edited in B'])
  })

  it('commits pending cell edits when focus leaves the notebook', () => {
    const onContentChange = vi.fn()
    const content = notebookContent()
    let editing: ReturnType<typeof useIpynbDocumentEditing> | null = null
    function Notebook(): React.JSX.Element {
      editing = useIpynbDocumentEditing({
        content,
        fileId: 'notebook-blur',
        notebook: parseIpynb(content),
        onContentChange,
        onDirtyStateHint: vi.fn(),
        onDeactivateEditor: vi.fn()
      })
      return <div data-testid="notebook" tabIndex={-1} onBlur={editing.onRootBlur} />
    }
    const view = render(<Notebook />)

    act(() => editing?.updateCellSource(0, 'typed then left'))
    fireEvent.blur(view.getByTestId('notebook'))

    expect(parseIpynb(onContentChange.mock.calls[0]?.[0] ?? '').cells[0]?.source).toBe(
      'typed then left'
    )
    view.unmount()
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
})
