// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorGutter } from 'monaco-editor/esm/vs/editor/browser/widget/diffEditor/utils/editorGutter.js'

// Guard the Monaco 0.55.1 patch: visible gutter views must dispose their global MenuRegistry toolbar entries.
class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

const noEvent = (): { dispose(): void } => ({ dispose: () => undefined })

function createGutter(): { gutter: EditorGutter; viewDispose: () => void; domNode: HTMLElement } {
  const editor = {
    onDidScrollChange: noEvent,
    onDidChangeModel: noEvent,
    onDidChangeViewZones: noEvent,
    onDidContentSizeChange: noEvent,
    getScrollTop: () => 0,
    hasModel: () => true,
    getModel: () => ({ getLineCount: () => 10 }),
    getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 10 }],
    getTopForLineNumber: (line: number) => (line - 1) * 20,
    getBottomForLineNumber: (line: number) => line * 20
  }
  const domNode = document.createElement('div')
  Object.defineProperty(domNode, 'clientHeight', { value: 200 })
  const viewDispose = vi.fn()
  const range = { startLineNumber: 2, endLineNumberExclusive: 4, intersect: () => range }
  const gutter = new EditorGutter(editor, domNode, {
    getIntersectingGutterItems: () => [{ id: 'hunk-1', range }],
    createView: () => ({ layout: () => undefined, dispose: viewDispose })
  })
  return { gutter, viewDispose, domNode }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('monaco-editor EditorGutter disposal patch', () => {
  it('disposes gutter item views that are still on screen when the gutter is disposed', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const { gutter, viewDispose, domNode } = createGutter()
    expect(domNode.childElementCount).toBeGreaterThan(1)
    expect(viewDispose).not.toHaveBeenCalled()

    gutter.dispose()

    expect(viewDispose).toHaveBeenCalledTimes(1)
  })
})
